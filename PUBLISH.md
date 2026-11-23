# 发布清单（publish checklist）

本地仓库已经初始化并提交，只差推送。以下三条路按需执行。

## 0. 一次性准备

```bash
cd F:\dsh-plugins\dsh-slim-oss
git log --oneline          # 应看到 c34ddaf feat: dsh-slim 1.0.0 …
```

## 1. GitHub

```bash
# 方式 A：有 gh CLI（推荐，会自动建仓库）
gh auth login
gh repo create dsh-slim --public --source=. --push \
  --description "DSH 会话一键瘦身插件：加号菜单删废话/去重合并，剪完自动重启" 

# 方式 B：网页建好空仓库后
git remote add origin https://github.com/<用户名>/dsh-slim.git
git branch -M main
git push -u origin main
```

打包上传用（GitHub Releases）：

```bash
git tag v1.0.0 && git push origin v1.0.0
# 然后网页 Releases → Draft a new release → 选 v1.0.0 → 上传 dsh-slim-1.0.0.zip
```

## 2. Gitee（国内）

```bash
git remote add gitee https://gitee.com/<用户名>/dsh-slim.git
git push -u gitee main
```

或网页「新建仓库」后 `git push -u gitee main`。Gitee 需要先在设置里配置 SSH 公钥或账号密码。

## 3. npm（可选，方便 `npm i -g` 装 CLI）

```bash
npm login                      # 需要 npm 账号
npm publish --access public    # package.json 里 name 若被占用，改成 dsh-slim-cli
```

发布前建议先把 `package.json` 的 `name` 改成没被占用的名字（先 `npm view dsh-slim` 查一下）。

## 4. 其他平台

- **GitCode / CSDN 代码托管**：注册后在网页导入 GitHub 仓库即可，无需额外命令。
- **掘金 / 知乎 / V2EX / 少数派**：发一篇介绍文，把 GitHub 链接放开头。
- **HN / Reddit r/LocalLLaMA**：英文版 README 摘要 + 仓库链接。

## 5. 发布前自检

- [ ] README 里的示例路径已换成你自己的（`DSH_PRUNE_*` 环境变量说明保留）
- [ ] `tools/restart-dsh.ps1` 里三处硬编码（exe 路径 / 工作目录 / 端口）已改
- [ ] `node tools/dsh-prune.mjs list` 能在裸环境跑通
- [ ] 没有把个人路径、token、cookie 提交上去：`git log -p | grep -i token`
