# 皮肤包

皮肤包把一个可复用的界面风格声明为本地扩展。皮肤包只声明元数据和宿主已经注册的视觉主题，不携带脚本、任意 CSS 或网络访问能力。

## 目录结构

```text
marketplace/skins/my-skin/
├── dsh-cyber.package.json
└── skin.json
```

`dsh-cyber.package.json` 的关键字段：

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "version": "1.0.0",
  "kind": "skin",
  "displayName": "我的皮肤",
  "summary": "一段面向用户的简短说明",
  "license": "MIT",
  "publisher": "发布者",
  "capabilities": ["ui:skin"],
  "dataEgress": [],
  "files": [{ "path": "skin.json", "sha256": "…" }],
  "entrypoints": [{ "id": "my-skin", "kind": "skin", "path": "skin.json" }]
}
```

`skin.json` 用于绑定宿主视觉主题：

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "skinId": "my-skin",
  "themeId": "my-skin",
  "displayName": "我的皮肤",
  "summary": "聊天、世界场景和面板一起切换"
}
```

`id` 必须与包 ID 相同。`themeId` 必须由宿主主题注册中心提供；应用不会把包里的任意代码或样式直接注入页面。需要自带缩略图时，可在 `skin.json` 增加 `previewAsset`，并将对应的 `assets/` 文件加入 `files` 与哈希校验。

皮肤安装后才会出现在世界顶部的皮肤下拉列表。默认皮肤始终可用，其他皮肤可在扩展市场安装、应用或卸载；卸载当前皮肤时，应用会安全回退到默认皮肤。
