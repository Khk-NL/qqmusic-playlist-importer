# QQ 音乐歌单导入器 · 改造版

把 CSV 歌曲清单导入 QQ 音乐自建歌单。基于 [Muziyaa/AutoCreateQQMusicSongList](https://github.com/Muziyaa/AutoCreateQQMusicSongList) 改造，保留上游 Git 历史和 MIT 许可证。当前版本 0.2.0，本地分支 `modernize-qqmusic`，没有推送至上游。

默认 **仅预检**：只搜索和记录匹配，不创建或写入歌单。不读取登录 Cookie、不调用 QQ 音乐私有接口，复用网页登录状态。本轮没有安装扩展或脚本，未验证真实账号写入。

## 使用

[从 GitHub 安装脚本](https://raw.githubusercontent.com/Khk-NL/qqmusic-playlist-importer/main/qqmusic_playlist_import.user.js)

1. 在已有 Tampermonkey 的浏览器中安装 `qqmusic_playlist_import.user.js`，打开 QQ 音乐网页版并登录。
2. 右下角填写唯一的目标歌单名称，选择 CSV，保持“仅预检”，开始导入。
3. 完成后“导出结果”，核对匹配歌曲 ID 和未找到、歧义项。
4. 确认后重新选择 CSV，取消“仅预检”，开始实际导入。目标不存在时会创建，只接受完全一致的名称。

## CSV

必需列 `song,artist`，可选 `date,mid,album,allow_variant`。模板为 `qqmusic_import_template.csv`。

```csv
song,artist,date,mid,album,allow_variant
Radiant,塞壬唱片-MSR,,001uwAoL3UzXbg,Radiant,false
```

- `song`：完整歌名，归一化大小写和空格后精确匹配。同名只保留 CSV 首条。
- `artist`：准确歌手名，多歌手以 `/` 分隔。每个指定歌手都必须存在，允许实际歌曲还有合作歌手；没有只按歌名的回退。
- `date`：核对过的首发日期，YYYY-MM-DD。当前不自动查日期，不用重发行日期替代首发日期。
- `mid`：QQ 歌曲链接 `/songDetail/<mid>` 最后一段，消除同名录音歧义，仍要求歌名和歌手一致。
- `album`：可选精确专辑名。
- `allow_variant`：默认 false。Live、Instrumental、Remix、伴奏、现场、翻唱等会排除；明确需要的官方版本才设 true，且必须填写完整版本名称。

候选按歌曲 ID 去重；不同 ID 的同名同歌手录音不会合并，多个合格候选标为 ambiguous。

## 从新到旧排序

“发行日期从新到旧”要求每首歌都有 date，并使用空歌单；同日保持 CSV 顺序。

“QQ 新歌插入位置”必须与当前账号的实际行为一致：顶部时倒序执行、末尾时正序执行。默认顶部可切换，尚未通过实际写入确认。脚本不会移动或删除已有歌曲，也不声称重复添加可以重排。

## 停止、恢复与失败

- 停止：后续点击、等待和导航会检查请求；已经发送的添加请求无法撤回。
- 继续：恢复保存的执行队列和游标，不重新反转；刷新页面后运行中的任务自动继续。
- 重试未成功项：保留先前成功记录，按原执行顺序处理 failed / ambiguous / not_found / pending。日期排序已有部分写入时，补加可能破坏顺序，会提示改用完整清单和新空歌单。
- 清除任务：只删除本地记录，不删除 QQ 歌单或歌曲。
- 导出结果：JSON 包含匹配 mid、专辑、状态、错误和历史记录。finished 表示处理结束，不代表全部成功。

使用 Web Locks 协调多个标签页；缺少该功能时停止任务。建议只留一个导入页面，期间不要切换账号或手动操作搜索结果。

## 当前适配与验证

2026-10-13 已现场核对 ryqq_v2 的搜索结果、批量工具栏、选择框、添加菜单及新建对话框。流程改为：批量操作 → 清除其他勾选 → 仅选目标歌曲 → 添加到 → 精确歌单名 → 等待本次成功提示。菜单关闭和旧成功提示不能作为成功证据。

网页通常只展示前 10 个结果；目标不在可见结果中时记为未找到，不绕过展示限制。没有成功提示时保留为 failed 供核对，不自动重试。

真实写入成功率、新歌插入位置、完整最终排序尚未验证。当前不提供完整歌单读回审计或自动发现首发日期。

```powershell
cd D:\Code\proj\qqmusic-playlist-importer
npm test
npm run check
```

使用 Node 内置测试模块，无新增依赖。15 项回归测试在隔离 VM 和模拟 DOM 中运行，不连接 QQ 账号。

上游说明见 `README.upstream.md`；现场记录见 `ADAPTATION.md`。上游 `song.csv`、`song.txt` 原样保留，不代表本次已核对的清单。
