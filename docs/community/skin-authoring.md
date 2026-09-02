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

## 声明式配色（可选）

皮肤包可以声明一组配色，宿主安装后会据此注册主题（此时 `themeId` 就是包 ID）。配色只允许六个 `#rrggbb` 十六进制颜色和一个 0.2–1 之间的透明度；任何 CSS 函数、`url()`、`var()`、颜色名、图片路径或样式表都会被安装器拒绝。可选的 `backdropSkinId` 只能是官方皮肤的 ID（如 `moonlit-tavern`、`sakura-shrine`），由宿主解析为对应场景，包本身不携带任何路径。

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "skinId": "my-skin",
  "themeId": "my-skin",
  "displayName": "我的皮肤",
  "summary": "深蓝底色与暖黄强调色",
  "palette": {
    "accentColor": "#5aa9e6",
    "pageBackground": "#0b1220",
    "panelBackground": "#121c2e",
    "textColor": "#eef2f7",
    "ownerBubbleColor": "#1f3352",
    "characterBubbleColor": "#16233a",
    "backdropOpacity": 0.9
  },
  "backdropSkinId": "moonlit-tavern"
}
```

扩展市场「皮肤 → 自定义皮肤」生成的皮肤包就是这种形状：分析器只提议配色，宿主按上述白名单重建，发布后出现在当前工作区的皮肤市场，安装与应用走与官方皮肤相同的路径。

皮肤安装后才会出现在世界顶部的皮肤下拉列表。默认皮肤始终可用，其他皮肤可在扩展市场安装、应用或卸载；卸载当前皮肤时，应用会安全回退到默认皮肤。
