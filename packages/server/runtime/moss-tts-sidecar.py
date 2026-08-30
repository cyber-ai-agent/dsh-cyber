from __future__ import annotations

import argparse
import base64
import json
import sys
import tempfile
import types
from pathlib import Path


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


def main() -> None:
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
            with tempfile.NamedTemporaryFile(suffix=".wav", dir=output_root, delete=False) as temporary:
                output_path = Path(temporary.name)
            try:
                result = runtime.synthesize(
                    text=text,
                    voice=voice,
                    output_audio_path=output_path,
                    streaming=True,
                    enable_wetext=False,
                    enable_normalize_tts_text=False,
                    max_new_frames=min(240, max(32, len(text) * 5)),
                )
                waveform = result["waveform"]
                if getattr(waveform, "ndim", 1) == 2:
                    waveform = waveform.mean(axis=1)
                pcm = waveform.astype("float32", copy=False).tobytes()
                print(json.dumps({
                    "type": "audio", "id": request_id, "sampleRate": int(result["sample_rate"]),
                    "pcmBase64": base64.b64encode(pcm).decode("ascii"), "voice": voice,
                }), flush=True)
            finally:
                output_path.unlink(missing_ok=True)
        except Exception as error:
            print(json.dumps({"type": "error", "id": locals().get("request_id", "unknown"), "message": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
