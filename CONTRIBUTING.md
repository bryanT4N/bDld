# 参与开发

- 修改前先阅读 [docs/DESIGN.md](docs/DESIGN.md)。设计变化时同步更新该文档，只写现状；版本变化写入 [CHANGELOG.md](CHANGELOG.md)。
- 提交前运行 `npm run typecheck` 与 `npm test`。修改 remux 模块时运行 `npm run verify:remux`；修改下载引擎或弹出窗口时运行 `npm run check:engine` 与 `npm run check:popup`。这些检查都在本机完成。
- `npm run e2e` 会访问 B 站。请只在必要时运行一次，不要循环运行或批量重试。
- 不引入运行时依赖。
- 界面文字与中文文档使用书面、简练的表述，同一个意思只用一个词。
- 真实的 B 站媒体文件不纳入版本库。
