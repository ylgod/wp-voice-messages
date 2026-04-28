=== 微信语音消息 ===
Contributors: HJYL
Tags: voice, audio, comments, wechat, voice message
Requires at least: 5.0
Tested up to: 6.5
Stable tag: 1.0.0
Requires PHP: 7.4
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

为 WordPress 评论和文章添加微信风格的语音消息功能。

== Description ==

**WP语音消息** 让你的 WordPress 网站支持语音消息，就像微信一样：

* 🎤 评论区按住说话，松开发送
* 🔊 文章内嵌入语音消息
* 🌊 播放时显示波形动画
* 📱 完美支持手机端
* 🌙 自动适配深色模式
* 🔒 支持登录用户 / 游客权限控制

= 使用方法 =

**评论区语音**：插件激活后自动在评论表单添加录音按钮，无需配置。

**文章内语音**：
按住录音，上传到文章里即可。


使用短代码：

    [voice url="https://你的网站.com/wp-content/uploads/2024/voice.webm" duration="12"]

带作者和时间的消息气泡：

    [voice_msg src="音频地址" duration="12" author="张三" time="刚刚"]

= REST API =

上传端点：`POST /wp-json/voice/v1/upload`

请求字段：
* `audio` - 音频文件（webm/mp3/wav/ogg/m4a）
* `duration` - 录音时长（秒）

= 支持格式 =

WebM (默认)、MP3、WAV、OGG、M4A、AAC

== Installation ==

1. 上传 `voice-messages` 文件夹到 `/wp-content/plugins/` 目录
2. 在 WordPress 后台「插件」页面激活插件
3. 访问「设置 → WP语音消息」配置选项（可选）
4. 评论区会自动出现录音按钮

== Frequently Asked Questions ==

= 游客可以发送语音吗？ =

可以，在设置页面开启「允许游客发言」即可。

= 支持哪些浏览器？ =

支持所有现代浏览器（Chrome、Firefox、Safari、Edge）。
iOS Safari 需要 14.3+，Android Chrome 需要 74+。

= 语音文件存在哪里？ =

存储在 WordPress 媒体库，路径为 `/wp-content/uploads/`，可在媒体库管理。

= 如何限制录音时长？ =

在「设置 → 微信语音 → 最大录音时长」中设置，默认 60 秒。

= 如何自定义样式？ =

在主题的 `style.css` 中覆盖以下 CSS 类：

    .voice-player {}       /* 播放器容器 */
    .voice-record-btn {}   /* 录音按钮 */
    .voice-wave-bars span {} /* 波形条 */

== Screenshots ==

1. 评论区录音按钮
2. 录音中状态（红色脉冲）
3. 语音消息播放器（绿色波形）
4. 文章内语音消息块
5. 后台设置页面

== Changelog ==

= 1.0.0 =
* 初始版本发布
* 评论区语音录制和播放
* 文章内短代码支持
* 微信风格波形动画
* 深色模式适配
* 游客权限控制
* REST API 上传接口

== Upgrade Notice ==

= 1.0.0 =
初始版本。