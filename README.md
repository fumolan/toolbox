# toolbox · 纯本地网页工具箱

GitHub Pages 静态站点：https://fumolan.github.io/toolbox/

所有工具**纯浏览器本地处理**，无后端、无上传、无统计。入口页 [`index.html`](index.html)。

## 工具列表

### 🪪 证件照生成（`idphoto/`）

手机前置摄像头自拍（或相册上传）→ MediaPipe 人像分割自动抠图 → 人脸关键点自动对齐（眼睛摆平、定位、定大小）→ 换底色 / 换正装 / 手动修边 → 导出标准尺寸 PNG 或六寸排版照。

- **单屏操作**：编辑页固定为一屏（上预览、中控制台、底部动作条），手机上不需要上下滑动
- **规格**：一寸 295×413 / 小二寸 390×567 / 二寸 413×579（300 DPI）
- **底色**：白 / 蓝 / 渐变蓝 / 红 / 浅灰
- **自动摆正**：歪头自拍按眼线旋正
- **手动修边**：抠图有残留或误删时，用「擦除 / 恢复」直接在预览上涂抹，可撤销
- **服装层（两种来源）**
  - 内置贴片：男装两套整件西装（藏蓝 / 深灰，按真实比例画）+ 女装西装、衬衫、Polo、高领毛衣。贴片的领口和肩线在加载时从透明通道自动识别：
    - 开襟西装：**沿服装上轮廓截掉人像躯干**，两肩按「平肩线」垫高并补上衣料本色（与原衣服颜色无关）；
      V 领用衬衫色沿真实领口形状补底；再按颜色清除脖子和两肩残留的深色便服（参考肤色从额头取，带胡须保护）。
      西装可用「长发勿裁」关闭截断
    - 高领款按领口做水平截断；低领的衬衫 / Polo 只做普通叠加
  - 或**上传自己的衣服照片**作为覆盖层：纯色底自动抠图、透明底 PNG 直接用，拖动 / 双指缩放旋转自由定位
- **示例人物**：男士 / 女士各两位（中国、欧美），点一下直接出成片；男士演示毛衣 / T 恤换西装，女士演示换底色（素材说明见 `idphoto/assets/demo/ATTRIBUTIONS.md`）
- **隐私**：照片全程不离开设备，模型请求也只打到本页自己的静态文件

## 技术栈与目录

无构建、无框架，原生 HTML/JS。AI 能力来自 MediaPipe Tasks Vision（**文件已内置本仓库**，不依赖任何外网 CDN）：

```
idphoto/
├── index.html / app.js
├── assets/                              # 服装贴片 + 示例照片
└── vendor/
    ├── vision_bundle.mjs                    # @mediapipe/tasks-vision 0.10.35
    ├── vision_wasm_internal.{js,wasm}       # WASM 运行时（SIMD）
    ├── vision_wasm_nosimd_internal.{js,wasm}# WASM 运行时（无 SIMD 的老浏览器自动回退）
    ├── selfie_segmenter.tflite              # 人像分割模型（256×256）
    └── blaze_face_short_range.tflite        # 人脸检测模型（6 关键点，用于眼睛定位 / 摆正）
```

## 本地开发

```bash
# 仓库根目录起静态服务（摄像头等 getUserMedia 要求 http://localhost 或 HTTPS）
py -m http.server 8080
# 打开 http://localhost:8080/idphoto/
```

直接双击 `index.html`（file:// 协议）时摄像头不可用，ES Module 也会被拦——必须走本地 HTTP 服务。

调试用的 URL 参数：

| 参数 | 作用 |
|---|---|
| `?demo=man-eu` | 页面打开直接载入某位示例人物（id 见 `DEMOS`） |
| `?demo=…&download=1` | 载入后自动下载成片 |
| `?debug=1` | 在预览上画出对齐 / 清除的参考线 |

## 部署

GitHub Pages，由 `.github/workflows/deploy-pages.yml` 在 push 到 main 时自动部署。
