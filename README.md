# 股票前端项目

这是一个基于 `React + Vite` 的本地前端项目。  
你可以把它理解成一个“网页应用”，在自己电脑上启动后，用浏览器打开即可使用。

## 许可证

这个仓库当前采用 `GNU AGPL v3.0 or later` 作为开源许可证，商业授权走单独协议。  
完整说明见根目录的 [LICENSE](/Users/kyleqiao/Profile/stock-frontend/LICENSE) 和 [COMMERCIAL-LICENSE.md](/Users/kyleqiao/Profile/stock-frontend/COMMERCIAL-LICENSE.md)。

## 你需要先准备什么

这个项目依赖 `Node.js` 和 `npm`。

如果你已经安装过，可以在终端里输入：

```bash
node -v
npm -v
```

如果都能看到版本号，说明已经安装好了。

## 第一次启动

第一次拿到项目时，先进入项目目录：

```bash
cd /path/to/stock-frontend
```

然后安装依赖：

```bash
npm install
```

这一步只需要在第一次运行项目时做一次。  
以后一般不用重复执行，除非项目依赖变了。

## 启动项目

在项目目录里运行：

```bash
npm run dev
```

启动成功后，终端里会看到类似下面的内容：

```bash
Local:   http://127.0.0.1:5173/
```

有时端口不是 `5173`，也可能是 `4173`、`5174` 或别的数字。  
以终端里实际显示的地址为准。

然后你把这个地址复制到浏览器里打开，就能看到页面。

## 停止项目

当你不想继续运行时：

1. 回到正在运行 `npm run dev` 的那个终端窗口
2. 按键盘 `Ctrl + C`

这样就停止了开发服务器。

## 下次再启动

以后再次使用时，通常只需要：

```bash
cd /path/to/stock-frontend
npm run dev
```

不需要每次都 `npm install`。

## 如果页面打不开

可以按下面顺序检查：

1. 确认终端里 `npm run dev` 还在运行，没有报错退出。
2. 确认你打开的是终端里显示的完整地址。
3. 如果地址打不开，先按 `Ctrl + C` 停掉，再重新运行：

```bash
npm run dev
```

## 项目结构

你现在最需要知道这几个文件：

- `src/App.jsx`：应用入口
- `src/components/AShareTD9InteractiveChart.jsx`：主要页面代码
- `src/components/ui/`：按钮、卡片这类基础 UI 组件
- `src/index.css`：全局样式

## 额外命令

### 检查代码是否能正常打包

```bash
npm run build
```

如果成功，会生成 `dist/` 目录。

### 检查代码风格和基础错误

```bash
npm run lint
```

## Docker 运行方式

如果你已经安装了 Docker，也可以用 Docker 来运行这个前端项目。

先确认 Docker Desktop 已经打开。  
如果没有打开，后面执行 `docker build` 时可能会看到类似错误：

```text
Cannot connect to the Docker daemon
```

这种情况不是项目坏了，而是 Docker 后台服务还没启动。

先进入项目目录：

```bash
cd /path/to/stock-frontend
```

然后构建 Docker 镜像：

```bash
docker build -t stock-frontend .
```

构建完成后启动容器：

```bash
docker run --rm -p 8080:80 stock-frontend
```

然后在浏览器打开：

```text
http://localhost:8080
```

### 停止 Docker 运行

如果你是用上面的命令启动的，回到那个终端窗口，按：

```text
Ctrl + C
```

这样容器会停止并自动删除，因为启动命令里用了 `--rm`。

### 后台运行 Docker

如果你想让它在后台运行，可以用：

```bash
docker run -d --name stock-frontend -p 8080:80 stock-frontend
```

停止后台容器：

```bash
docker stop stock-frontend
```

删除容器：

```bash
docker rm stock-frontend
```

如果 `docker rm` 提示容器不存在，说明它已经被删掉了，可以忽略。

## 最简单的使用流程

每次用这个项目，按这个顺序就行：

1. 打开终端
2. 进入项目目录
3. 运行 `npm run dev`
4. 打开终端里给出的本地网址
5. 用完后按 `Ctrl + C` 停止

如果你愿意，我下一步可以继续帮你写一个“完全小白版”的说明：
- 怎么打开终端
- 怎么进入文件夹
- 怎么修改代码后在浏览器里看到变化
