# 当前页面适配记录

日期：2026-10-13，Edge 中已登录的 QQ 音乐网页版。

上游：https://github.com/Muziyaa/AutoCreateQQMusicSongList

基线：064e90fcb0af0c3c832d924165e9d7bc229c2217（2026-03-25）。保留 Git 历史和 MIT LICENSE，本地分支 modernize-qqmusic。

| 功能 | 现场观察到的结构 |
| --- | --- |
| 搜索行 | `.songlist__item` |
| 歌名和 ID | `.songlist__songname_txt a[title]`，href 为 `/n/ryqq_v2/songDetail/<mid>` |
| 歌手 | `.songlist__artist a[title]` |
| 专辑 | `.songlist__album a` |
| 批量操作 | `.mod_songlist_toolbar .mod_btn__icon_batch` 的 a 父节点 |
| 选择框 | `.songlist__item .songlist__checkbox`，开启后默认 checked=false |
| 添加入口 | `.mod_songlist_toolbar .mod_btn__icon_add` 的 a 父节点 |
| 歌单菜单 | `#fav_pop ul[role="menu"] .operate_menu__link[title]`，项目异步加载 |
| 自建歌单 | `.playlist__title_txt a`，数量 `.playlist__number` |
| 新建按钮 | `button.js_create_new` |
| 新建输入 | `[role="dialog"] #new_playlist` |
| 新建确认 | `[role="dialog"] .popup_new_list .popup__ft .mod_btn_green` |
| 登录头像 | `.js_userInfo_img` |

Radiant 当前搜索结果：mid 001uwAoL3UzXbg，歌手塞壬唱片-MSR / Mary Clare，专辑 Radiant。

现场仅打开添加菜单和新建对话框，没有提交添加或创建，随后取消。未修改账号歌单，未安装脚本。

`npm test` 15 项通过；`npm run check` 通过。现场观察用于确定选择器，模拟 DOM 用于测试控制逻辑，不能替代真实写入和排序验证。后续需用小型测试歌单验证成功提示、插入位置、跳转后的断点继续及最终歌曲序列。
