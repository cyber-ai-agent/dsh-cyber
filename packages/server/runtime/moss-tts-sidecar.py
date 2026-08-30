from __future__ import annotations

import argparse
import base64
import json
import sys
import types
from pathlib import Path

import numpy as np


STREAM_DECODE_FRAME_BATCH = 8


def install_lightweight_import_stubs(output_root: Path) -> None:
    torch = types.ModuleType("torch")
    torchaudio = types.ModuleType("torchaudio")
    sys.modules.setdefault("torch", torch)
    sys.modules.setdefault("torchaudio", torchaudio)

    package = types.ModuleType("moss_tts_nano")
    package.__path__ = []
    defaults = types.ModuleType("moss_tts_nano.defaults")
    defaults.DEFAULT_OUTPUT_DIR = output_root
    sys.modules.setdefault("moss_tts_nano", package)
    sys.modules.setdefault("moss_tts_nano.defaults", defaults)

    normalization = types.ModuleType("text_normalization_pipeline")

    class WeTextProcessingManager:
        pass

    def prepare_tts_request_texts(**kwargs):
        text = " ".join(str(kwargs.get("text") or "").replace("\r", " ").replace("\n", " ").split())
        return {
            "text": text,
            "prompt_text": "",
            "normalized_text": text,
            "normalized_prompt_text": "",
            "normalization_method": "dsh-basic",
            "text_normalization_language": "zh" if any("\u3400" <= char <= "\u9fff" for char in text) else "en",
            "text_normalization_enabled": True,
            "wetext_processing_enabled": False,
            "normalize_tts_text_enabled": True,
        }

    normalization.WeTextProcessingManager = WeTextProcessingManager
    normalization.prepare_tts_request_texts = prepare_tts_request_texts
    sys.modules.setdefault("text_normalization_pipeline", normalization)


def emit_audio(request_id: str, sequence: int, waveform: np.ndarray, sample_rate: int) -> None:
    pcm = np.asarray(waveform, dtype=np.float32).reshape(-1).tobytes()
    print(json.dumps({
        "type": "audio",
        "id": request_id,
        "sequence": sequence,
        "sampleRate": sample_rate,
        "pcmBase64": base64.b64encode(pcm).decode("ascii"),
    }), flush=True)


def stream_synthesize(runtime, request_id: str, text: str, voice: str) -> int:
    runtime.manifest["generation_defaults"]["max_new_frames"] = min(240, max(32, len(text) * 5))
    prepared = runtime.prepare_synthesis_text(
        text=text,
        voice=voice,
        enable_wetext=False,
        enable_normalize_tts_text=False,
    )
    prepared_text = str(prepared["text"])
    prompt_audio_codes = runtime.resolve_prompt_audio_codes(voice=voice, prompt_audio_path=None)
    text_chunks = runtime.split_voice_clone_text(prepared_text, max_tokens=75)
    sample_rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
    sequence = 0

    for chunk_index, chunk_text in enumerate(text_chunks):
        text_token_ids = runtime.encode_text(chunk_text)
        request_rows = runtime.build_voice_clone_request_rows(prompt_audio_codes, text_token_ids)
        pending_frames: list[list[int]] = []
        runtime.codec_streaming_session.reset()

        def decode_pending(force: bool) -> None:
            nonlocal sequence
            while pending_frames and (force or len(pending_frames) >= STREAM_DECODE_FRAME_BATCH):
                frame_count = len(pending_frames) if force else STREAM_DECODE_FRAME_BATCH
                frame_chunk = pending_frames[:frame_count]
                del pending_frames[:frame_count]
                decoded = runtime.codec_streaming_session.run_frames(frame_chunk)
                if decoded is None:
                    continue
                audio, audio_length = decoded
                if audio_length <= 0:
                    continue
                waveform = np.asarray(audio[0, :, :audio_length], dtype=np.float32).mean(axis=0)
                emit_audio(request_id, sequence, waveform, sample_rate)
                sequence += 1

        def on_frame(_generated_frames: list[list[int]], _step_index: int, frame: list[int]) -> None:
            pending_frames.append(list(frame))
            decode_pending(False)

        try:
            runtime.generate_audio_frames(request_rows, on_frame=on_frame)
            decode_pending(True)
        finally:
            runtime.codec_streaming_session.reset()

        if chunk_index < len(text_chunks) - 1:
            pause_seconds = runtime.estimate_voice_clone_inter_chunk_pause_seconds(chunk_text)
            pause_samples = max(0, int(round(sample_rate * pause_seconds)))
            if pause_samples > 0:
                emit_audio(request_id, sequence, np.zeros((pause_samples,), dtype=np.float32), sample_rate)
                sequence += 1

    if sequence == 0:
        raise RuntimeError("MOSS 语音没有生成音频")
    return sequence


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    model_root = Path(args.model_root).resolve()
    runtime_root = Path(args.runtime_root).resolve()
    output_root = model_root / "output"
    output_root.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(runtime_root))
    install_lightweight_import_stubs(output_root)

    from onnx_tts_runtime import OnnxTtsRuntime

    runtime = OnnxTtsRuntime(model_dir=model_root, thread_count=max(1, args.threads), max_new_frames=180, sample_mode="fixed")
    voices = [str(item.get("voice")) for item in runtime.list_builtin_voices() if item.get("voice")]
    print(json.dumps({"type": "ready", "voices": voices}, ensure_ascii=False), flush=True)

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            text = str(request["text"]).strip()
            voice = str(request.get("voice") or (voices[0] if voices else "Junhao"))
            if not text:
                raise ValueError("播报文字不能为空")
            sequence = stream_synthesize(runtime, request_id, text, voice)
            print(json.dumps({"type": "done", "id": request_id, "sequence": sequence, "voice": voice}), flush=True)
        except Exception as error:
            print(json.dumps({"type": "error", "id": locals().get("request_id", "unknown"), "message": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
