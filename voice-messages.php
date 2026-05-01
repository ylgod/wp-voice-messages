<?php
/**
 * Plugin Name: WP语音消息
 * Plugin URI: https://hjyl.org
 * Description: 为 WordPress 评论和文章添加微信风格的语音消息功能。支持按住说话、自动上传、波形播放。
 * Version: 3.15
 * Author: HJYL
 * Author URI: https://hjyl.org
 * Text Domain: voice-messages
 * Domain Path: /languages
 * Requires at least: 5.0
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

define('VOICE_PLUGIN_VERSION', '3.15');
define('VOICE_PLUGIN_URL', plugin_dir_url(__FILE__));
define('VOICE_PLUGIN_DIR', plugin_dir_path(__FILE__));

/**
 * 主类
 */
final class Voice_Messages {

    private static $instance = null;

    public static function instance() {
        if (is_null(self::$instance)) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->init_hooks();
    }

    private function init_hooks() {
        // REST API - 优先级提高确保注册
        add_action('rest_api_init', array($this, 'register_rest_routes'), 10);

        // 前台资源
        add_action('wp_enqueue_scripts', array($this, 'enqueue_assets'));

        // 评论表单
        // 录音按钮+附件区+隐藏字段：comment_form_top 在表单最开头触发
        add_action('comment_form_top', array($this, 'add_voice_area_before_submit'));

        // 保存评论语音
        add_action('comment_post', array($this, 'save_voice_in_comment'), 10, 2);

        // 评论列表显示语音
        add_filter('comment_text', array($this, 'display_voice_in_comment'), 10, 2);

        // 短代码
        add_shortcode('voice', array($this, 'voice_shortcode'));
        add_shortcode('voice_msg', array($this, 'voice_message_shortcode'));

        // 管理后台
        if (is_admin()) {
            add_action('admin_menu', array($this, 'add_admin_menu'));
            add_action('admin_init', array($this, 'register_settings'));
            // 后台评论页面加载资源
            add_action('admin_enqueue_scripts', array($this, 'admin_enqueue_assets'));
            // 古腾堡编辑器资源
            add_action('enqueue_block_editor_assets', array($this, 'enqueue_block_editor_assets'));
            // 经典编辑器 Meta Box
            add_action('add_meta_boxes', array($this, 'add_voice_meta_box'));
            add_action('save_post', array($this, 'save_voice_meta_box'), 10, 2);
        }

        // 古腾堡区块注册（前台也需渲染）
        add_action('init', array($this, 'register_voice_block'));

        // 古腾堡编辑器 iframe 内注入样式（WP 5.8+）
        add_filter('block_editor_settings_all', array($this, 'inject_editor_iframe_styles'), 10, 2);
        // 古腾堡区块前台渲染由 register_block_type 的 render_callback 处理

        // AJAX 上传
        add_action('wp_ajax_voice_upload', array($this, 'ajax_upload'));
        add_action('wp_ajax_nopriv_voice_upload', array($this, 'ajax_upload'));

        // MIME 类型支持
        add_filter('upload_mimes', array($this, 'add_mime_types'), 999);
        add_filter('wp_check_filetype_and_ext', array($this, 'fix_filetype_check'), 10, 4);
    }

    /**
     * 添加音频 MIME 类型
     */
    public function add_mime_types($mimes) {
        $mimes['webm'] = 'audio/webm';
        $mimes['m4a'] = 'audio/mp4';
        $mimes['ogg'] = 'audio/ogg';
        $mimes['wav'] = 'audio/wav';
        return $mimes;
    }

    /**
     * 修复 WordPress 文件类型检测
     * 解决 "抱歉，您无权上传此文件类型" 错误
     */
    public function fix_filetype_check($data, $file, $filename, $mimes) {
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        
        $allowed = array(
            'webm' => 'audio/webm',
            'm4a'  => 'audio/mp4',
            'ogg'  => 'audio/ogg',
            'wav'  => 'audio/wav',
        );
        
        if (isset($allowed[$ext])) {
            $data['ext'] = $ext;
            $data['type'] = $allowed[$ext];
        }
        
        return $data;
    }

    // ==================== REST API ====================

    public function register_rest_routes() {
        register_rest_route('voice/v1', '/upload', array(
            'methods'             => 'POST',
            'callback'            => array($this, 'handle_upload'),
            'permission_callback' => array($this, 'check_upload_permission'),
        ));
        
        // 测试端点
        register_rest_route('voice/v1', '/test', array(
            'methods'             => 'GET',
            'callback'            => '__return_true',
            'permission_callback' => '__return_true',
        ));
        
        // 创建评论端点
        register_rest_route('voice/v1', '/comment', array(
            'methods'             => 'POST',
            'callback'            => array($this, 'create_voice_comment'),
            'permission_callback' => array($this, 'check_comment_permission'),
        ));
        
    }
    
    public function check_upload_permission() {
        return true;
    }
    
    public function check_comment_permission() {
        // 允许登录用户或访客（根据设置）
        if (is_user_logged_in()) {
            return true;
        }
        return get_option('voice_allow_guest', true);
    }

    public function handle_upload($request) {
        // 权限检查
        if (!is_user_logged_in() && !get_option('voice_allow_guest', true)) {
            return new WP_Error(
                'forbidden',
                '请登录后再发送语音',
                array('status' => 403)
            );
        }

        // 获取上传文件（兼容旧版 WordPress）
        // WP_REST_Request::get_file() 只在 WP 5.6+ 可用
        $file = null;
        if (method_exists($request, 'get_file')) {
            $file = $request->get_file('audio');
        } else {
            // 旧版兼容：直接从 $_FILES 获取
            $file = isset($_FILES['audio']) ? $_FILES['audio'] : null;
        }

        if (empty($file) || !isset($file['tmp_name']) || empty($file['tmp_name'])) {
            return new WP_Error('no_file', '没有收到文件', array('status' => 400));
        }

        if (isset($file['error']) && $file['error'] !== UPLOAD_ERR_OK && $file['error'] !== 0) {
            $error_messages = array(
                UPLOAD_ERR_INI_SIZE   => '文件大小超过服务器限制',
                UPLOAD_ERR_FORM_SIZE  => '文件大小超过表单限制',
                UPLOAD_ERR_PARTIAL    => '文件只有部分被上传',
                UPLOAD_ERR_NO_FILE    => '没有文件被上传',
            );
            $msg = isset($error_messages[$file['error']]) ? $error_messages[$file['error']] : '上传失败';
            return new WP_Error('upload_error', $msg, array('status' => 400));
        }

        // 格式验证
        $allowed_types = array('webm', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'mp4');
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

        if (!in_array($ext, $allowed_types)) {
            return new WP_Error('invalid_type', '不支持的格式：' . $ext, array('status' => 400));
        }

        // 大小验证
        $max_size = 10 * 1024 * 1024; // 10MB
        if (isset($file['size']) && $file['size'] > $max_size) {
            return new WP_Error('too_large', '文件超过10MB限制', array('status' => 400));
        }

        // 加载必需文件
        if (!function_exists('media_handle_upload')) {
            require_once(ABSPATH . 'wp-admin/includes/image.php');
            require_once(ABSPATH . 'wp-admin/includes/file.php');
            require_once(ABSPATH . 'wp-admin/includes/media.php');
        }

        // 安全文件名：voice_YYYYMMDD_HHMMSS_随机8位（北京时间）
        $random_str = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 8);
        $bj_ts = time() + 8 * 3600 - intval(date('Z'));
        $file['name'] = 'voice_' . gmdate('Ymd_His', $bj_ts) . '_' . $random_str . '.' . $ext;

        // 确保 $_FILES 中有数据（media_handle_upload 依赖 $_FILES）
        $_FILES['audio'] = $file;

        $attachment_id = media_handle_upload('audio', 0);

        if (is_wp_error($attachment_id)) {
            error_log('[VoiceMSG] media_handle_upload error: ' . $attachment_id->get_error_message());
            return $attachment_id;
        }

        // 标记为语音消息
        update_post_meta($attachment_id, '_voice_type', 'voice_message');
        
        $duration = $request->get_param('duration');
        if ($duration) {
            update_post_meta($attachment_id, '_voice_duration', intval($duration));
        }
        
        $url = wp_get_attachment_url($attachment_id);
        if (!$url) {
            return new WP_Error('url_error', '获取文件URL失败', array('status' => 500));
        }

        return array(
            'success'  => true,
            'id'       => $attachment_id,
            'url'      => $url,
            'duration' => $duration ? intval($duration) : 0,
        );
    }
    
    /**
     * 获取客户端真实 IP
     */
    private function get_client_ip() {
        $ip_keys = array(
            'HTTP_CF_CONNECTING_IP', // Cloudflare
            'HTTP_X_FORWARDED_FOR',
            'HTTP_X_REAL_IP',
            'REMOTE_ADDR',
        );
        foreach ($ip_keys as $key) {
            if (!empty($_SERVER[$key])) {
                $ip = $_SERVER[$key];
                // X-Forwarded-For 可能有多个 IP，取第一个
                if (strpos($ip, ',') !== false) {
                    $ip = trim(explode(',', $ip)[0]);
                }
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
        }
        return '0.0.0.0';
    }

    /**
     * 创建语音评论
     */
    public function create_voice_comment($request) {
        $post_id = $request->get_param('post_id');
        $voice_url = $request->get_param('voice_url');
        $voice_id = $request->get_param('voice_id');
        $duration = $request->get_param('duration');
        $author = $request->get_param('author');
        $email = $request->get_param('email');
        $url = $request->get_param('url');
        $user_agent = $request->get_param('user_agent');
        $parent = $request->get_param('parent');

        // 验证文章
        if (!$post_id || !get_post($post_id)) {
            return new WP_Error('invalid_post', '无效的文章ID', array('status' => 400));
        }
        
        // 验证语音
        if (empty($voice_url)) {
            return new WP_Error('no_voice', '缺少语音数据', array('status' => 400));
        }
        
        // 访客必须填写昵称和邮箱
        if (!is_user_logged_in()) {
            $author = $author ? sanitize_text_field($author) : '';
            $email = $email ? sanitize_email($email) : '';
            if (empty($author) || empty($email)) {
                return new WP_Error('missing_info', '请填写昵称和邮箱', array('status' => 400));
            }
        }
        
        // 获取客户端 IP
        $client_ip = $this->get_client_ip();
        
        // 构建评论数据
        $comment_data = array(
            'comment_post_ID'      => intval($post_id),
            'comment_content'      => '<span class="voice-comment-icon"></span> #语音消息<!--' . time() . '-->',
            'comment_type'         => 'comment',
            'comment_approved'     => 1, // 自动批准
            'comment_author_IP'    => $client_ip,
        );
        
        // 用户信息
        if (is_user_logged_in()) {
            $user = wp_get_current_user();
            $comment_data['user_id'] = $user->ID;
            $comment_data['comment_author'] = $user->display_name;
            $comment_data['comment_author_email'] = $user->user_email;
            $comment_data['comment_author_url'] = !empty($user->user_url) ? esc_url_raw($user->user_url) : '';
        } else {
            // 访客
            $comment_data['comment_author'] = $author;
            $comment_data['comment_author_email'] = $email;
            if (!empty($url)) {
                $sanitized_url = esc_url_raw($url);
                $comment_data['comment_author_url'] = $sanitized_url;
            }
        }
        
        // 回复评论
        if ($parent) {
            $comment_data['comment_parent'] = intval($parent);
        }

        // 保存 UA 到标准字段（供 wp-useragent 等插件读取）
        $ua = !empty($user_agent) ? sanitize_text_field($user_agent ) : (isset($_SERVER['HTTP_USER_AGENT']) ? sanitize_text_field($_SERVER['HTTP_USER_AGENT']) : '');
        if ($ua) {
            $comment_data['comment_agent'] = $ua;
        }

        // 创建评论（使用 wp_new_comment 触发邮件通知和垃圾评论检查）
        $comment_id = wp_new_comment($comment_data);
        
        if (is_wp_error($comment_id) || !$comment_id) {
            error_log('[VoiceMSG] Failed to create comment: ' . print_r($comment_id, true));
            return new WP_Error('comment_failed', '评论创建失败', array('status' => 500));
        }
        
        // 保存语音元数据
        update_comment_meta($comment_id, 'voice_urls', sanitize_url($voice_url));
        update_comment_meta($comment_id, 'voice_durations', intval($duration));

        // 保存 UA 到 comment_meta（额外记录，wp-useragent 读 comment_agent 字段）
        if ($ua) {
            update_comment_meta($comment_id, 'voice_user_agent', $ua);
        }

        // 获取头像
        $avatar_url = '';
        if (is_user_logged_in()) {
            $user = wp_get_current_user();
            $avatar_url = get_avatar_url($user->ID, array('size' => 32));
        } else {
            $avatar_url = get_avatar_url($email, array('size' => 32));
        }

        return array(
            'success'    => true,
            'comment_id' => $comment_id,
            'voice_url'  => esc_url($voice_url),
            'duration'   => intval($duration),
            'author'     => $comment_data['comment_author'],
            'author_url' => !empty($comment_data['comment_author_url']) ? $comment_data['comment_author_url'] : '',
            'avatar'     => $avatar_url,
            'message'    => '语音评论已发送',
        );
    }

    // ==================== 前台资源 ====================

    public function enqueue_assets() {
        // 首页和单篇文章都加载（首页评论区也需要语音按钮）
        if (!is_singular() && !is_page() && !is_single() && !is_home() && !is_front_page()) {
            return;
        }

        // 首页直接加载（首页评论区由主题渲染，无法精确判断）
        if (is_home() || is_front_page()) {
            // 首页有评论区就加载，不做短代码检测
        } else {
            // 单篇文章/页面：检查短代码和评论
            $post_id = get_queried_object_id();
            $has_shortcode = false;
            
            if ($post_id) {
                $post = get_post($post_id);
                if ($post && !is_wp_error($post)) {
                    $has_shortcode = has_shortcode($post->post_content, 'voice') || has_shortcode($post->post_content, 'voice_msg');
                    // 检查古腾堡区块
                    if (function_exists('has_block') && has_block('voice-messages/voice-block', $post)) {
                        $has_shortcode = true;
                    }
                }
            }

            $has_comments = comments_open() || have_comments();

            if (!$has_shortcode && !$has_comments) {
                return;
            }
        }

        // CSS
        $css_path = VOICE_PLUGIN_DIR . 'assets/css/voice-messages.css';
        $css_ver = file_exists($css_path) ? filemtime($css_path) : VOICE_PLUGIN_VERSION;

        wp_enqueue_style(
            'voice-messages',
            VOICE_PLUGIN_URL . 'assets/css/voice-messages.css',
            array(),
            $css_ver
        );

        // JS
        $js_path = VOICE_PLUGIN_DIR . 'assets/js/voice-messages.js';
        $js_ver = file_exists($js_path) ? filemtime($js_path) : VOICE_PLUGIN_VERSION;

        wp_enqueue_script(
            'voice-messages',
            VOICE_PLUGIN_URL . 'assets/js/voice-messages.js',
            array('jquery'),
            $js_ver,
            true
        );

        wp_localize_script('voice-messages', 'VoiceMSG', array(
            'ajaxUrl'        => admin_url('admin-ajax.php'),
            'restUrl'        => rest_url('voice/v1/upload'),
            'commentUrl'     => rest_url('voice/v1/comment'),
            'postId'         => get_queried_object_id(),
            'nonce'          => wp_create_nonce('voice_nonce'),
            'restNonce'      => wp_create_nonce('wp_rest'),
            'strHoldToTalk'  => '按住说话',
            'strRelease'     => '松开结束',
            'strUploading'   => '上传中...',
            'strFailed'      => '发送失败',
            'strTooShort'    => '录音太短',
            'strTooLong'     => '录音太长',
            'strNoPerm'      => '请允许麦克风权限',
            'strMaxDuration' => intval(get_option('voice_max_duration', 60)),
            'allowGuest'     => get_option('voice_allow_guest', true) ? true : false,
            'isLoggedIn'     => is_user_logged_in(),
        ));
    }

    // ==================== 评论功能 ====================

    // 录音按钮 + 附件区 + 隐藏字段（comment_form_top，表单最开头触发）
    // 使用 class 而非 id，支持多评论区共存
    public function add_voice_area_before_submit() {
        $max_duration = intval(get_option('voice_max_duration', 60));
        ?>
        <div class="voice-comment-wrapper">
            <div class="voice-submit-row">
                <button type="button" class="voice-record-btn" data-context="comment">
                    <span class="voice-icon"></span>
                </button>
                <div class="voice-record-status">
                    <span class="voice-red-dot"></span>
                    <span class="voice-record-timer">0"</span>
                </div>
                <div class="voice-attachments"></div>
            </div>
            <input type="hidden" name="voice_urls" class="voice-urls-input" value="">
            <input type="hidden" name="voice_durations" class="voice-durations-input" value="">
        </div>
        <?php
    }

    public function save_voice_in_comment($comment_id, $comment_approved) {
        if (!isset($_POST['voice_urls']) || empty($_POST['voice_urls'])) {
            return;
        }

        $urls = sanitize_text_field(wp_unslash($_POST['voice_urls']));
        $durations = isset($_POST['voice_durations']) ? sanitize_text_field(wp_unslash($_POST['voice_durations'])) : '';

        if (!empty($urls)) {
            update_comment_meta($comment_id, 'voice_urls', $urls);
        }
        if (!empty($durations)) {
            update_comment_meta($comment_id, 'voice_durations', $durations);
        }

        // 将评论内容更新为 #评论ID 语音消息
        $voice_count = count(array_filter(explode(',', $urls)));
        $voice_text = $voice_count > 1
            ? '#' . $comment_id . ' ' . $voice_count . '条语音消息'
            : '#' . $comment_id . ' 语音消息';
        wp_update_comment(array(
            'comment_ID'      => $comment_id,
            'comment_content' => '<span class="voice-comment-icon"></span> ' . $voice_text,
        ));
    }

    public function display_voice_in_comment($comment_text, $comment) {
        if (!is_object($comment) || !isset($comment->comment_ID)) {
            return $comment_text;
        }

        $voice_urls = get_comment_meta($comment->comment_ID, 'voice_urls', true);
        $voice_durations = get_comment_meta($comment->comment_ID, 'voice_durations', true);

        if (empty($voice_urls)) {
            return $comment_text;
        }

        $urls = array_filter(array_map('trim', explode(',', $voice_urls)));
        $durations = array_filter(array_map('trim', explode(',', $voice_durations)));

        if (empty($urls)) {
            return $comment_text;
        }

        $html = '<p class="voice-messages-wrapper">';

        foreach ($urls as $i => $url) {
            $duration = isset($durations[$i]) ? intval($durations[$i]) : 0;
            $html .= $this->build_player_html($url, $duration, 'comment_' . $comment->comment_ID . '_' . $i);
        }

        $html .= '</p>';

        // 紧贴评论文字，避免 wpautop 在中间插入 <br>
        return rtrim($comment_text) . $html;
    }

    // ==================== 短代码 ====================

    public function voice_shortcode($atts) {
        $atts = shortcode_atts(array(
            'url'      => '',
            'duration' => 0,
            'id'       => '',
        ), $atts, 'voice');

        if (empty($atts['url'])) {
            return '';
        }

        $player_id = !empty($atts['id']) ? sanitize_html_class($atts['id']) : 'v_' . uniqid();
        return $this->build_player_html(esc_url($atts['url']), intval($atts['duration']), $player_id);
    }

    public function voice_message_shortcode($atts) {
        $atts = shortcode_atts(array(
            'src'      => '',
            'duration' => 0,
            'author'   => '',
            'time'     => '',
        ), $atts, 'voice_msg');

        if (empty($atts['src'])) {
            return '';
        }

        $html = '<p class="voice-message-block">';
        
        if (!empty($atts['author'])) {
            $html .= '<span class="voice-msg-author">' . esc_html($atts['author']) . '</span>';
        }
        
        $player_id = 'vmsg_' . uniqid();
        $html .= $this->build_player_html(esc_url($atts['src']), intval($atts['duration']), $player_id);
        
        if (!empty($atts['time'])) {
            $html .= '<span class="voice-msg-time">' . esc_html($atts['time']) . '</span>';
        }
        
        $html .= '</p>';

        return $html;
    }

    // ==================== 播放器 HTML ====================

    private function build_player_html($url, $duration = 0, $player_id = '') {
        if (empty($url)) {
            return '';
        }

        $player_id = sanitize_html_class($player_id ?: 'vp_' . uniqid());
        $duration = max(0, intval($duration));

        $wave_bars = '';
        for ($i = 1; $i <= 8; $i++) {
            $delay = $i * 0.08;
            $wave_bars .= '<span style="animation-delay:' . esc_attr($delay) . 's"></span>';
        }

        // 单行输出，避免 wpautop 插入 <br>
        return '<span class="voice-player" data-url="' . esc_url($url) . '" data-duration="' . esc_attr($duration) . '" id="' . esc_attr($player_id) . '">' .
               '<span class="voice-play-icon">▶</span>' .
               '<span class="voice-wave-wrap"><span class="voice-wave-bars">' . $wave_bars . '</span></span>' .
               '<span class="voice-duration-label">' . esc_html($duration) . '"</span>' .
               '<audio class="voice-audio-el" src="' . esc_url($url) . '" preload="none"></audio>' .
               '</span>';
    }

    // ==================== 后台管理 ====================

    public function add_admin_menu() {
        add_options_page(
            'WP语音消息设置',
            'WP语音消息',
            'manage_options',
            'voice-messages',
            array($this, 'settings_page_html')
        );
    }

    public function register_settings() {
        register_setting('voice_messages_group', 'voice_allow_guest', array(
            'type'              => 'boolean',
            'sanitize_callback' => array($this, 'sanitize_bool'),
        ));

        register_setting('voice_messages_group', 'voice_max_duration', array(
            'type'              => 'integer',
            'sanitize_callback' => array($this, 'sanitize_duration'),
        ));

        add_settings_section('voice_main_section', '基础设置', '__return_empty_string', 'voice-messages');

        add_settings_field('voice_allow_guest', '允许游客发言', array($this, 'field_allow_guest'), 'voice-messages', 'voice_main_section');
        add_settings_field('voice_max_duration', '最大录音时长', array($this, 'field_max_duration'), 'voice-messages', 'voice_main_section');
    }

    public function sanitize_bool($value) {
        return !empty($value);
    }

    public function sanitize_duration($value) {
        $val = intval($value);
        return max(5, min(300, $val));
    }

    public function field_allow_guest() {
        $value = get_option('voice_allow_guest', true);
        ?>
        <label>
            <input type="checkbox" name="voice_allow_guest" value="1" <?php checked(1, $value); ?>>
            允许未登录用户发送语音消息
        </label>
        <?php
    }

    public function field_max_duration() {
        $value = get_option('voice_max_duration', 60);
        ?>
        <input type="number" name="voice_max_duration" value="<?php echo esc_attr($value); ?>" min="5" max="300" style="width:80px">
        秒（5-300）
        <?php
    }

    public function settings_page_html() {
        ?>
        <div class="wrap">
            <h1>WP语音消息 设置</h1>
            <form method="post" action="options.php">
                <?php 
                settings_fields('voice_messages_group'); 
                do_settings_sections('voice-messages'); 
                submit_button(); 
                ?>
            </form>

            <hr>
            <h2>使用说明</h2>
            
            <h3>文章中插入语音</h3>
            <p><strong>古腾堡编辑器：</strong>在区块搜索中搜索「语音消息」，添加后点击录音即可。</p>
            <p><strong>经典编辑器：</strong>在侧边栏「语音消息」面板中录制，或手动插入短代码。</p>
            <p>短代码：<code>[voice url="音频地址" duration="10"]</code></p>
            <p>或：<code>[voice_msg src="音频地址" duration="12" author="张三" time="刚刚"]</code></p>

            <h3>评论显示</h3>
            <p>语音消息会自动显示在评论下方，无需额外配置。</p>
        </div>
        <?php
    }

    /**
     * 后台资源加载（评论页面）
     */
    public function admin_enqueue_assets($hook) {
        // 评论页面和文章编辑页面
        if ($hook !== 'edit-comments.php' && strpos($hook, 'comment') === false && $hook !== 'post.php' && $hook !== 'post-new.php') {
            return;
        }

        $css_path = VOICE_PLUGIN_DIR . 'assets/css/voice-messages.css';
        $css_ver = file_exists($css_path) ? filemtime($css_path) : VOICE_PLUGIN_VERSION;
        wp_enqueue_style('voice-messages', VOICE_PLUGIN_URL . 'assets/css/voice-messages.css', array(), $css_ver);

        $js_path = VOICE_PLUGIN_DIR . 'assets/js/voice-messages.js';
        $js_ver = file_exists($js_path) ? filemtime($js_path) : VOICE_PLUGIN_VERSION;
        wp_enqueue_script('voice-messages', VOICE_PLUGIN_URL . 'assets/js/voice-messages.js', array('jquery'), $js_ver, true);
    }

    // ==================== 古腾堡编辑器 ====================

    /**
     * 注册古腾堡区块
     */
    public function register_voice_block() {
        if (!function_exists('register_block_type')) {
            return;
        }

        register_block_type('voice-messages/voice-block', array(
            'attributes' => array(
                'url' => array(
                    'type' => 'string',
                    'default' => '',
                ),
                'audioId' => array(
                    'type' => 'number',
                    'default' => 0,
                ),
                'duration' => array(
                    'type' => 'number',
                    'default' => 0,
                ),
            ),
            'render_callback' => array($this, 'render_voice_block'),
        ));
    }

    /**
     * 前台渲染古腾堡区块的 data div 为播放器
     */
    public function render_voice_block($attributes) {
        $url = isset($attributes['url']) ? esc_url($attributes['url']) : '';
        $duration = isset($attributes['duration']) ? intval($attributes['duration']) : 0;
        if (empty($url)) return '';
        $player_id = 'vb_' . uniqid();
        return '<p class="voice-messages-wrapper">' .
               $this->build_player_html($url, $duration, $player_id) .
               '</p>';
    }

    /**
     * 古腾堡编辑器资源加载
     */
    public function enqueue_block_editor_assets() {
        $css_path = VOICE_PLUGIN_DIR . 'assets/css/voice-block-editor.css';
        $css_ver = file_exists($css_path) ? filemtime($css_path) : VOICE_PLUGIN_VERSION;
        wp_enqueue_style(
            'voice-block-editor',
            VOICE_PLUGIN_URL . 'assets/css/voice-block-editor.css',
            array('wp-edit-blocks'),
            $css_ver
        );

        $js_path = VOICE_PLUGIN_DIR . 'assets/js/voice-block.js';
        $js_ver = file_exists($js_path) ? filemtime($js_path) : VOICE_PLUGIN_VERSION;
        wp_enqueue_script(
            'voice-block-editor',
            VOICE_PLUGIN_URL . 'assets/js/voice-block.js',
            array('wp-blocks', 'wp-element', 'wp-components', 'wp-block-editor', 'wp-i18n'),
            $js_ver,
            true
        );

        // 传递配置给 JS
        wp_localize_script('voice-block-editor', 'VoiceBlock', array(
            'nonce'      => wp_create_nonce('voice_nonce'),
            'restNonce'  => wp_create_nonce('wp_rest'),
            'uploadUrl'  => rest_url('voice/v1/upload'),
        ));
    }

    /**
     * 将编辑器专用 CSS 注入到古腾堡 iframe 内部
     * WP 5.8+ 的编辑器画布使用 iframe，enqueue_block_editor_assets 的样式无法穿透
     */
    public function inject_editor_iframe_styles($settings, $context) {
        $css_file = VOICE_PLUGIN_DIR . 'assets/css/voice-block-editor.css';
        if (file_exists($css_file)) {
            $css = file_get_contents($css_file);
            if ($css) {
                $settings['styles'][] = array('css' => $css, '__unstableType' => 'css');
            }
        }
        return $settings;
    }

    // ==================== 经典编辑器 Meta Box ====================

    /**
     * 注册 Meta Box
     */
    public function add_voice_meta_box() {
        add_meta_box(
            'voice_messages_meta_box',
            '🎙 语音消息',
            array($this, 'render_voice_meta_box'),
            array('post', 'page'),
            'side',
            'default'
        );
    }

    /**
     * 渲染 Meta Box
     */
    public function render_voice_meta_box($post) {
        wp_nonce_field('voice_meta_box_nonce', 'voice_meta_nonce');
        $voice_url = get_post_meta($post->ID, '_voice_url', true);
        $voice_duration = get_post_meta($post->ID, '_voice_duration', true);
        ?>
        <div id="voiceClassicEditor">
            <div id="voiceClassicStatus"<?php echo empty($voice_url) ? ' style="display:none"' : ''; ?>>
                <p><strong>已添加语音：</strong></p>
                <span class="voice-player" data-url="<?php echo esc_url($voice_url); ?>" data-duration="<?php echo esc_attr($voice_duration); ?>" id="v_classic_<?php echo $post->ID; ?>">
                    <span class="voice-play-icon">▶</span>
                    <span class="voice-wave-wrap">
                        <span class="voice-wave-bars">
                        <?php for ($i = 1; $i <= 8; $i++): ?>
                            <span style="animation-delay:<?php echo $i * 0.08; ?>s"></span>
                        <?php endfor; ?>
                        </span>
                    </span>
                    <span class="voice-duration-label"><?php echo esc_html($voice_duration); ?>"</span>
                    <audio class="voice-audio-el" src="<?php echo esc_url($voice_url); ?>" preload="none"></audio>
                </span>
                <input type="hidden" name="voice_url" value="<?php echo esc_attr($voice_url); ?>" />
                <input type="hidden" name="voice_duration" value="<?php echo esc_attr($voice_duration); ?>" />
                <button type="button" class="button button-small" id="voiceRemoveBtn" style="margin-top:6px">移除语音</button>
            </div>
            <div id="voiceClassicRecord"<?php echo !empty($voice_url) ? ' style="display:none"' : ''; ?>>
                <button type="button" class="button button-primary" id="voiceClassicRecordBtn">
                    <span class="voice-icon"></span> 录制语音
                </button>
                <button type="button" class="button" id="voiceClassicStopBtn" style="display:none">
                    ⏹ 停止
                </button>
                <span id="voiceClassicTimer" style="display:none; margin-left:8px; font-weight:600; color:#ff4757">0"</span>
            </div>
            <div id="voiceClassicPreview" style="display:none; margin-top:10px">
                <p><strong>预览：</strong><span id="voiceClassicPreviewDur">0"</span></p>
                <audio id="voiceClassicAudio" controls style="display:block; width:100%; margin:6px 0"></audio>
                <button type="button" class="button button-primary" id="voiceClassicInsertBtn">插入文章</button>
                <button type="button" class="button" id="voiceClassicCancelBtn">取消</button>
            </div>
        </div>
        <script>
        (function() {
            var recorder = null, chunks = [], startTime = 0, timer = null, previewBlob = null, previewUrl = null, previewDuration = 0;

            var recordBtn = document.getElementById('voiceClassicRecordBtn');
            var stopBtn = document.getElementById('voiceClassicStopBtn');
            var timerEl = document.getElementById('voiceClassicTimer');
            var previewEl = document.getElementById('voiceClassicPreview');
            var previewDur = document.getElementById('voiceClassicPreviewDur');
            var insertBtn = document.getElementById('voiceClassicInsertBtn');
            var cancelBtn = document.getElementById('voiceClassicCancelBtn');
            var removeBtn = document.getElementById('voiceRemoveBtn');
            var statusEl = document.getElementById('voiceClassicStatus');
            var recordEl = document.getElementById('voiceClassicRecord');

            function getSupportedMime() {
                var types = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg','audio/wav'];
                for (var i = 0; i < types.length; i++) { if (MediaRecorder.isTypeSupported(types[i])) return types[i]; }
                return 'audio/webm';
            }

            recordBtn.onclick = function() {
                navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}).then(function(stream) {
                    var mime = getSupportedMime();
                    recorder = new MediaRecorder(stream, {mimeType:mime, audioBitsPerSecond:32000});
                    chunks = [];
                    startTime = Date.now();
                    recorder.ondataavailable = function(e) { if(e.data.size>0) chunks.push(e.data); };
                    recorder.start(100);
                    recordBtn.style.display = 'none';
                    stopBtn.style.display = '';
                    timerEl.style.display = '';
                    timer = setInterval(function() {
                        timerEl.textContent = Math.floor((Date.now()-startTime)/1000) + '"';
                        if (Math.floor((Date.now()-startTime)/1000) >= 120) stopClassicRecord();
                    }, 1000);
                }).catch(function(err) { alert('麦克风权限获取失败: ' + err.message); });
            };

            stopBtn.onclick = function() { stopClassicRecord(); };

            function stopClassicRecord() {
                if (!recorder) return;
                if (timer) { clearInterval(timer); timer = null; }
                var savedChunks = chunks.slice(); chunks = [];
                recorder.onstop = function() {
                    var dur = Math.floor((Date.now()-startTime)/1000);
                    if (dur < 1) { alert('录音太短'); resetUI(); return; }
                    var mime = recorder.mimeType || 'audio/webm';
                    previewBlob = new Blob(savedChunks, {type:mime});
                    previewUrl = URL.createObjectURL(previewBlob);
                    previewDuration = dur;
                    previewDur.textContent = dur + '"';
                    // 设置预览播放器
                    var audioEl = document.getElementById('voiceClassicAudio');
                    audioEl.src = previewUrl;
                    stopBtn.style.display = 'none';
                    timerEl.style.display = 'none';
                    previewEl.style.display = '';
                };
                recorder.stop();
                recorder.stream.getTracks().forEach(function(t){t.stop();});
            }

            cancelBtn.onclick = function() {
                var audioEl = document.getElementById('voiceClassicAudio');
                audioEl.pause();
                audioEl.src = '';
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                previewBlob = null; previewUrl = null; previewDuration = 0;
                previewEl.style.display = 'none';
                resetUI();
            };

            insertBtn.onclick = function() {
                if (!previewBlob) { alert('录音已过期'); return; }
                insertBtn.disabled = true;
                insertBtn.textContent = '上传中...';
                var ext = previewBlob.type.includes('mp4') ? 'm4a' : 'webm';
                var fd = new FormData();
                fd.append('audio', previewBlob, 'voice_'+Date.now()+'.'+ext);
                fd.append('duration', previewDuration);
                var restNonce = '<?php echo wp_create_nonce('wp_rest'); ?>';

                fetch('<?php echo rest_url('voice/v1/upload'); ?>', {
                    method:'POST',
                    credentials:'same-origin',
                    headers:{'X-WP-Nonce': restNonce},
                    body:fd
                }).then(function(r){return r.text()}).then(function(text){
                    var data;
                    try { data = JSON.parse(text); } catch(e) { throw new Error('服务器返回无效数据'); }
                    // REST API 成功返回 {data: {success:true, url:'...'}}
                    var result = (data.data && data.data.url) ? data.data : data;
                    if (result.success && result.url) {
                        // 清理预览播放器
                        var audioEl = document.getElementById('voiceClassicAudio');
                        audioEl.pause(); audioEl.src = '';
                        // 写入隐藏字段
                        document.querySelector('input[name=voice_url]').value = result.url;
                        document.querySelector('input[name=voice_duration]').value = result.duration || previewDuration;
                        // 更新 statusEl 中的播放器 URL 和时长
                        var playerEl = statusEl.querySelector('.voice-player');
                        if (playerEl) {
                            playerEl.setAttribute('data-url', result.url);
                            playerEl.setAttribute('data-duration', result.duration || previewDuration);
                            var playerAudio = playerEl.querySelector('.voice-audio-el');
                            if (playerAudio) playerAudio.src = result.url;
                            var durLabel = playerEl.querySelector('.voice-duration-label');
                            if (durLabel) durLabel.textContent = (result.duration || previewDuration) + '"';
                        }
                        // 在编辑器光标处插入 shortcode
                        var shortcode = '[voice url="' + result.url + '" duration="' + (result.duration || previewDuration) + '"]';
                        if (typeof tinyMCE !== 'undefined' && tinyMCE.activeEditor && !tinyMCE.activeEditor.isHidden()) {
                            tinyMCE.activeEditor.insertContent(shortcode);
                        } else if (typeof wp !== 'undefined' && wp.data && wp.data.select('core/editor')) {
                            wp.data.dispatch('core/block-editor').insertBlocks(
                                wp.blocks.createBlock('core/shortcode', {text: shortcode})
                            );
                        } else {
                            // 纯文本编辑器
                            var textarea = document.getElementById('content');
                            if (textarea) {
                                var pos = textarea.selectionStart;
                                var val = textarea.value;
                                textarea.value = val.substring(0, pos) + shortcode + val.substring(pos);
                                textarea.selectionStart = textarea.selectionEnd = pos + shortcode.length;
                            }
                        }
                        // 更新预览
                        statusEl.style.display = '';
                        recordEl.style.display = 'none';
                        previewEl.style.display = 'none';
                        if (previewUrl) URL.revokeObjectURL(previewUrl);
                        previewBlob = null; previewUrl = null;
                    } else {
                        var errMsg = (result.message || (data.data && data.data.message) || '上传失败');
                        throw new Error(errMsg);
                    }
                }).catch(function(err){
                    alert('上传失败: '+err.message);
                    insertBtn.disabled = false;
                    insertBtn.textContent = '插入文章';
                });
            };

            removeBtn.onclick = function() {
                document.querySelector('input[name=voice_url]').value = '';
                document.querySelector('input[name=voice_duration]').value = '';
                statusEl.style.display = 'none';
                recordEl.style.display = '';
            };

            function resetUI() {
                recordBtn.style.display = '';
                stopBtn.style.display = 'none';
                timerEl.style.display = 'none';
            }
        })();
        </script>
        <?php
    }

    /**
     * 保存 Meta Box 数据
     */
    public function save_voice_meta_box($post_id, $post) {
        if (!isset($_POST['voice_meta_nonce']) || !wp_verify_nonce($_POST['voice_meta_nonce'], 'voice_meta_box_nonce')) {
            return;
        }
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
            return;
        }
        if (!current_user_can('edit_post', $post_id)) {
            return;
        }

        $voice_url = isset($_POST['voice_url']) ? esc_url_raw($_POST['voice_url']) : '';
        $voice_duration = isset($_POST['voice_duration']) ? intval($_POST['voice_duration']) : 0;

        if (!empty($voice_url)) {
            update_post_meta($post_id, '_voice_url', $voice_url);
            update_post_meta($post_id, '_voice_duration', $voice_duration);
        } else {
            delete_post_meta($post_id, '_voice_url');
            delete_post_meta($post_id, '_voice_duration');
        }
    }

    // ==================== AJAX ====================

    public function ajax_upload() {
        check_ajax_referer('voice_nonce', 'nonce');

        if (!is_user_logged_in() && !get_option('voice_allow_guest', true)) {
            wp_send_json_error(array('message' => '请登录'));
        }

        if (empty($_FILES['audio'])) {
            wp_send_json_error(array('message' => '没有文件'));
        }

        // 加载必需文件
        if (!function_exists('media_handle_upload')) {
            require_once(ABSPATH . 'wp-admin/includes/image.php');
            require_once(ABSPATH . 'wp-admin/includes/file.php');
            require_once(ABSPATH . 'wp-admin/includes/media.php');
        }

        // 安全文件名：voice_YYYYMMDD_HHMMSS_随机8位
        $ext = strtolower(pathinfo($_FILES['audio']['name'], PATHINFO_EXTENSION));
        $random_str = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 8);
        $bj_ts = time() + 8 * 3600 - intval(date('Z'));
        $_FILES['audio']['name'] = 'voice_' . gmdate('Ymd_His', $bj_ts) . '_' . $random_str . '.' . $ext;

        $id = media_handle_upload('audio', 0);

        if (is_wp_error($id)) {
            wp_send_json_error(array('message' => $id->get_error_message()));
        }

        wp_send_json_success(array(
            'url'      => wp_get_attachment_url($id),
            'id'       => $id,
            'duration' => isset($_POST['duration']) ? intval($_POST['duration']) : 0,
        ));
    }
}

// 初始化 - 更早的钩子确保 REST API 注册
function voice_messages_init() {
    return Voice_Messages::instance();
}

// 优先级 0 确保 REST API 路由注册
add_action('init', 'voice_messages_init', 0);

// 备用：如果 init 已过，直接初始化
if (did_action('init')) {
    voice_messages_init();
}
