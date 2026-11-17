# DeepTutor Manim 能力补全说明

本文件记录使用 Docker 部署「数学动画（Manim）」的验证环境，以及本分支的代码生成和 Windows 渲染修复。

## 1. 已验证的 Docker 环境

| 项 | 状态 |
|---|---|
| 容器镜像 | `deeptutor-manim:1.7.2`（由 `ghcr.io/hkuds/deeptutor:latest` + 本地改动 `docker commit` 生成，约 9.1 GB） |
| 容器 | `deeptutor`，`127.0.0.1:3782`，`restart=unless-stopped`，数据卷 `deeptutor-data:/app/data` |
| Manim | 0.22.1（pip） |
| LaTeX 工具链 | texlive-latex-base/recommended/extra + fonts-recommended/extra + `dvisvgm` |
| 中文字体 | `fonts-noto-cjk`（Manim `Text()` 中文正常渲染） |
| ffmpeg | 镜像自带 |
| DeepTutor 模块 | `renderer-manim` ready=true |
| 能力开关 | 「数学动画」模式可用；输出 720p30 mp4 |

## 2. 镜像内安装步骤（可重放）

在基础镜像容器内以 root 执行：

```sh
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libcairo2-dev pkg-config libpango1.0-dev build-essential \
  texlive-latex-base texlive-latex-recommended texlive-fonts-recommended \
  texlive-latex-extra texlive-fonts-extra dvisvgm fonts-noto-cjk
python -m pip install "manim>=0.19.0"
apt-get clean
```

然后固化：

```powershell
docker stop deeptutor
docker commit deeptutor deeptutor-manim:1.7.2
docker rm deeptutor
docker run -d --name deeptutor -p 127.0.0.1:3782:3782 -v deeptutor-data:/app/data --restart unless-stopped deeptutor-manim:1.7.2
```

## 3. 代码生成和 Windows 渲染

使用 DeepSeek Flash 时曾遇到推理用完 12000 token 的输出预算（`finish_reason=length`、`reasoning_tokens=12000`）。
本分支对 `deepseek-flash` 和 `deepseek-v4-flash` 的动画代码生成与修复请求关闭思考。DeepSeek 原生绑定将该设置转换为 `thinking.type=disabled`。

在 Windows 上，如果工作区的媒体目录路径过长，Manim 会改用独立的临时目录生成媒体文件。最终产物复制回工作区，临时目录随渲染结束清理。

## 4. 能力参数

Settings → Capabilities（或 API `PUT /api/capabilities/settings`）：

```json
"math_animator": { "temperature": 0.3, "max_tokens": 16000 }
```

- 默认 12000 太小；推理模型下 16000 能覆盖"简短动画"的代码生成。
- 若仍被截断，可继续上调（DeepSeek 接口实测接受 32000），或换非推理模型。
- 重试机制会在截断时自动放大预算（`min(base*2, base*1.5^n)`）。

## 5. 产物位置

数学动画每次运行的产物：

```
/app/data/user/workspaces/<workspace_id>/outputs/math_animator/
  <session_id>/<turn_id>/artifacts/<turn_id>-<SceneName>.mp4
```

在上述 Docker 配置中，产物保存在数据卷 `deeptutor-data` 内。

## 6. 已验证的演示

| 演示 | 来源 | 时长 |
|---|---|---|
| 三角函数变换 | DeepTutor「数学动画」模式，y=sin x → 2sin(2x+π/3) | 55.8 s |
| 二次函数抛物线 | DeepTutor「数学动画」模式，y=x² 顶点/对称轴/单调性 | 23.3 s |
| 三角函数图像变换 | 手工编写的 Manim 场景（验证工具链） | 14.7 s |
| 二次函数视频讲解 | DeepTutor「视频讲解」模式（Remotion，浏览器播放） | 1:31 |

## 7. 已知边界

- 代码生成依赖模型输出预算；复杂场景（>10 个动画对象/长公式）可能需要调大 `max_tokens`
  或分多次生成。
- LaTeX 首次编译有缓存成本；单个 MathTex 约 1-2 s。
- Manim 渲染在 CPU 上跑，720p30 的 20-60 秒动画通常 1-3 分钟。
- 重建容器时，使用包含所需工具链和本分支代码的镜像。第 2 节记录了 Docker 环境的安装步骤。
