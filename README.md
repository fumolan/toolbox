# toolbox · 纯本地网页工具箱

GitHub Pages 静态站点：https://fumolan.github.io/toolbox/

所有工具**纯浏览器本地处理**，无后端、无上传、无统计。入口页 [`index.html`](index.html)。

## 工具列表

### 🪪 证件照生成（`idphoto/`）

手机前置摄像头自拍 → MediaPipe 人像分割自动抠图 → 人脸关键点自动对齐证件模板 → 换底色 / 换正装 → 导出标准尺寸 PNG 或六寸排版照。桌面端可用「相册上传」兜底。

- **规格**：一寸 295×413 / 小二寸 390×567 / 二寸 413×579（均 300 DPI）
- **底色**：白 / 蓝 / 渐变蓝 / 红 / 浅灰
- **换装**：内置 8 款预抠服装贴片（男/女 × 西装/衬衫/短袖/毛衣），或**上传自己的衣服照片**作为覆盖层（纯色底自动抠图、透明底 PNG 直用），拖动 / 双指缩放旋转自由定位，肩线与宽度可调（内置款）
- **隐私**：照片全程不离开设备，模型请求也只打到本页自己的静态文件

## 技术栈与目录

无构建、无框架，原生 HTML/JS。AI 能力来自 MediaPipe Tasks Vision（**文件已内置本仓库**，不依赖任何外网 CDN）：

```
idphoto/vendor/
├── vision_bundle.mjs                    # @mediapipe/tasks-vision 0.10.35
├── vision_wasm_internal.{js,wasm}       # WASM 运行时（SIMD）
├── vision_wasm_nosimd_internal.{js,wasm}# WASM 运行时（无 SIMD 老浏览器自动回退）
├── selfie_segmenter.tflite              # 人像分割模型（256×256）
└── blaze_face_short_range.tflite        # 人脸检测模型（6 关键点，用于眼睛定位对齐）
```

## 本地开发

```bash
# 仓库根目录起静态服务（摄像头等 getUserMedia 要求 http://localhost 或 HTTPS）
py -m http.server 8080
# 打开 http://localhost:8080/idphoto/
```

注意直接双击 `index.html`（file:// 协议）时摄像头不可用，ES Module 也会被拦——必须走本地 HTTP 服务。

## 部署

GitHub Pages：main 分支 / 根目录。push 后自动发布，首次启用需 1-2 分钟。
