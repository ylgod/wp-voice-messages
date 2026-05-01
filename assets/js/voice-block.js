/**
 * 微信语音消息 - 古腾堡区块
 * 支持后台文章编辑器按住录音
 */
(function() {
    'use strict';

    var el = wp.element.createElement;
    var __ = wp.i18n.__;
    var useState = wp.element.useState;
    var useEffect = wp.element.useEffect;
    var useRef = wp.element.useRef;
    var InspectorControls = wp.blockEditor.InspectorControls;
    var PanelBody = wp.components.PanelBody;
    var TextControl = wp.components.TextControl;
    var Button = wp.components.Button;
    var Placeholder = wp.components.Placeholder;
    var icons = wp.icons;

    // SVG 麦克风图标
    var micIcon = el('svg', {
        viewBox: '0 0 24 24',
        width: 24,
        height: 24,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2
    },
        el('rect', { x: 9, y: 1, width: 6, height: 12, rx: 3 }),
        el('path', { d: 'M19 10v1a7 7 0 0 1-14 0v-1' }),
        el('line', { x1: 12, y1: 18, x2: 12, y2: 23 }),
        el('line', { x1: 8, y1: 23, x2: 16, y2: 23 })
    );

    // 录音状态常量
    var STATE_IDLE = 'idle';
    var STATE_RECORDING = 'recording';
    var STATE_PREVIEW = 'preview';
    var STATE_UPLOADED = 'uploaded';

    /**
     * 录音器组件
     */
    function VoiceRecorder(props) {
        var attrs = props.attributes;
        var setAttributes = props.setAttributes;

        var previewStateHook = useState(false);
        var previewPlayingState = previewStateHook[0];
        var setPreviewPlayingState = previewStateHook[1];

        var stateHook = useState(STATE_IDLE);
        var recorderState = stateHook[0];
        var setRecorderState = stateHook[1];

        var durationHook = useState(0);
        var duration = durationHook[0];
        var setDuration = durationHook[1];

        var timerHook = useState('0"');
        var timerDisplay = timerHook[0];
        var setTimerDisplay = timerHook[1];

        var recorderRef = useRef(null);
        var chunksRef = useRef([]);
        var startTimeRef = useRef(0);
        var timerRef = useRef(null);
        var streamRef = useRef(null);
        var previewUrlRef = useRef(null);
        var previewBlobRef = useRef(null);
        var audioRef = useRef(null);
        var playingRef = useRef(false);

        // 清理副作用
        useEffect(function() {
            return function() {
                if (timerRef.current) clearInterval(timerRef.current);
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(function(t) { t.stop(); });
                }
                if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
            };
        }, []);

        // 获取支持的 MIME 类型
        function getSupportedMime() {
            var types = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
                'audio/ogg;codecs=opus',
                'audio/ogg',
                'audio/wav'
            ];
            for (var i = 0; i < types.length; i++) {
                if (MediaRecorder.isTypeSupported(types[i])) return types[i];
            }
            return 'audio/webm';
        }

        // 开始录音
        function startRecord() {
            navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                    channelCount: 1
                }
            }).then(function(stream) {
                streamRef.current = stream;
                var mimeType = getSupportedMime();
                var recorder = new MediaRecorder(stream, {
                    mimeType: mimeType,
                    audioBitsPerSecond: 32000
                });

                chunksRef.current = [];
                startTimeRef.current = Date.now();

                recorder.ondataavailable = function(e) {
                    if (e.data && e.data.size > 0) {
                        chunksRef.current.push(e.data);
                    }
                };

                recorder.onerror = function() {
                    stopRecord(true);
                };

                recorder.start(100);
                recorderRef.current = recorder;
                setRecorderState(STATE_RECORDING);

                // 启动计时器
                timerRef.current = setInterval(function() {
                    var seconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
                    setTimerDisplay(seconds + '"');
                    setDuration(seconds);

                    // 最长 120 秒
                    if (seconds >= 120) {
                        stopRecord();
                    }
                }, 1000);

            }).catch(function(err) {
                console.error('[VoiceBlock] 麦克风权限获取失败:', err);
                alert('请允许麦克风权限');
            });
        }

        // 停止录音
        function stopRecord(isError) {
            if (!recorderRef.current || recorderState !== STATE_RECORDING) return;

            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }

            if (isError) {
                chunksRef.current = [];
                recorderRef.current.stop();
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(function(t) { t.stop(); });
                }
                setRecorderState(STATE_IDLE);
                return;
            }

            var savedChunks = chunksRef.current.slice();
            chunksRef.current = [];

            var currentRecorder = recorderRef.current;
            var currentStream = streamRef.current;

            currentRecorder.onstop = function() {
                var dur = Math.floor((Date.now() - startTimeRef.current) / 1000);
                if (savedChunks.length === 0 || dur < 1) {
                    if (dur < 1) alert('录音太短，请至少录制 1 秒');
                    setRecorderState(STATE_IDLE);
                    return;
                }

                var mime = currentRecorder.mimeType || 'audio/webm';
                previewBlobRef.current = new Blob(savedChunks, { type: mime });
                previewUrlRef.current = URL.createObjectURL(previewBlobRef.current);
                setDuration(dur);
                setRecorderState(STATE_PREVIEW);
            };

            currentRecorder.stop();
            if (currentStream) {
                currentStream.getTracks().forEach(function(t) { t.stop(); });
            }
        }

        // 上传音频到媒体库
        function uploadVoice() {
            if (!previewBlobRef.current) {
                alert('录音数据丢失，请重新录制');
                return;
            }

            var ext = previewBlobRef.current.type.includes('mp4') ? 'm4a' : 'webm';
            var filename = 'voice_' + Date.now() + '.' + ext;

            var formData = new FormData();
            formData.append('audio', previewBlobRef.current, filename);
            formData.append('duration', duration);

            // 显示上传中
            setRecorderState('uploading');

            fetch(VoiceBlock.uploadUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'X-WP-Nonce': VoiceBlock.restNonce || ''
                },
                body: formData
            }).then(function(res) {
                return res.text().then(function(text) {
                    try {
                        return JSON.parse(text);
                    } catch (e) {
                        // JSON parse error
                        throw new Error('服务器返回无效数据');
                    }
                });
            }).then(function(data) {
                // WordPress REST API: 成功返回 {data: {success: true, url: '...'}}
                // 失败返回 {data: {error: 'code', message: '...'}}
                var result = data.data || data;
                if (result.success && result.url) {
                    setAttributes({
                        url: result.url,
                        audioId: result.id || 0,
                        duration: duration || result.duration || 0
                    });
                    setRecorderState(STATE_UPLOADED);

                    // 清理预览
                    if (previewUrlRef.current) {
                        URL.revokeObjectURL(previewUrlRef.current);
                        previewUrlRef.current = null;
                    }
                    previewBlobRef.current = null;
                } else {
                    var errMsg = (result.message || result.error || '上传失败');
                    throw new Error(errMsg);
                }
            }).catch(function(err) {
                console.error('[VoiceBlock] 上传失败:', err);
                alert('上传失败: ' + err.message);
                setRecorderState(STATE_PREVIEW);
            });
        }

        // 取消录音
        function cancelRecord() {
            if (previewUrlRef.current) {
                URL.revokeObjectURL(previewUrlRef.current);
                previewUrlRef.current = null;
            }
            previewBlobRef.current = null;
            setRecorderState(STATE_IDLE);
            setDuration(0);
            setTimerDisplay('0"');
        }

        // 重新录制
        function rerecord() {
            setAttributes({ url: '', audioId: 0, duration: 0 });
            setRecorderState(STATE_IDLE);
            setDuration(0);
            setTimerDisplay('0"');
        }

        // 编辑器内播放/暂停
        var playHook = useState('▶');
        var playIcon = playHook[0];
        var setPlayIcon = playHook[1];
        var durHook = useState('');
        var durLabel = durHook[0];
        var setDurLabel = durHook[1];

        function toggleEditorPlay() {
            if (!audioRef.current) return;
            if (playingRef.current) {
                audioRef.current.pause();
                playingRef.current = false;
                setPlayIcon('▶');
            } else {
                audioRef.current.play().catch(function() {});
                playingRef.current = true;
                setPlayIcon('⏸');
            }
        }

        // === 渲染各状态 UI ===

        // 已上传：显示播放器（含真实音频播放）
        if (recorderState === STATE_UPLOADED || attrs.url) {
            var waveBars = [];
            for (var i = 1; i <= 8; i++) {
                waveBars.push(el('span', {
                    key: 'bar-' + i,
                    style: { animationDelay: (i * 0.08) + 's' }
                }));
            }

            var curDuration = attrs.duration || duration;

            return el('div', { className: 'voice-block-editor' },
                el('div', {
                    className: 'voice-block-player' + (playingRef.current ? ' playing' : ''),
                    onClick: toggleEditorPlay,
                    style: { cursor: 'pointer' }
                },
                    el('div', { className: 'voice-block-play-icon' }, playIcon),
                    el('div', { className: 'voice-wave-wrap' },
                        el('div', { className: 'voice-wave-bars' }, waveBars)
                    ),
                    el('span', { className: 'voice-duration-label' },
                        durLabel || (curDuration + '"')
                    ),
                    el('audio', {
                        src: attrs.url,
                        preload: 'none',
                        ref: audioRef,
                        onEnded: function() {
                            playingRef.current = false;
                            setPlayIcon('▶');
                        },
                        onTimeUpdate: function(e) {
                            var a = e.target;
                            if (a.duration) {
                                var remain = Math.ceil(a.duration - a.currentTime);
                                setDurLabel(remain + '"');
                            }
                        },
                        onPlay: function() {
                            playingRef.current = true;
                            setPlayIcon('⏸');
                        },
                        onPause: function() {
                            playingRef.current = false;
                            setPlayIcon('▶');
                        }
                    })
                ),
                el('div', { className: 'voice-block-actions' },
                    el(Button, {
                        isSmall: true,
                        isDestructive: true,
                        onClick: rerecord
                    }, __('重新录制', 'voice-messages'))
                ),
                // InspectorControls: 侧边栏设置
                el(InspectorControls, null,
                    el(PanelBody, {
                        title: __('语音消息设置', 'voice-messages'),
                        initialOpen: true
                    },
                        el(TextControl, {
                            label: __('音频地址', 'voice-messages'),
                            value: attrs.url,
                            onChange: function(val) { setAttributes({ url: val }); },
                            __next40pxDefaultSize: true,
                            __nextHasNoMarginBottom: true
                        }),
                        el(TextControl, {
                            label: __('时长(秒)', 'voice-messages'),
                            type: 'number',
                            value: attrs.duration || duration,
                            onChange: function(val) { setAttributes({ duration: parseInt(val) || 0 }); },
                            __next40pxDefaultSize: true,
                            __nextHasNoMarginBottom: true
                        })
                    )
                )
            );
        }

        // 上传中
        if (recorderState === 'uploading') {
            return el('div', { className: 'voice-block-editor voice-block-uploading' },
                el('div', { className: 'voice-block-spinner' }),
                el('p', null, '上传中...')
            );
        }

        // 录音中
        if (recorderState === STATE_RECORDING) {
            return el('div', { className: 'voice-block-editor voice-block-recording' },
                el('div', { className: 'voice-block-record-area' },
                    el('div', { className: 'voice-block-mic recording-pulse' }, micIcon),
                    el('div', { className: 'voice-block-timer' }, timerDisplay),
                    el(Button, {
                        isPrimary: true,
                        isDestructive: true,
                        onClick: function() { stopRecord(); }
                    }, __('停止录音', 'voice-messages'))
                )
            );
        }

        // 预览（使用 audioRef + previewPlayingState，参考已上传状态的实现）
        if (recorderState === STATE_PREVIEW) {
            var previewWaveBars = [];
            for (var j = 1; j <= 8; j++) {
                previewWaveBars.push(el('span', {
                    key: 'pbar-' + j,
                    style: { animationDelay: (j * 0.08) + 's' }
                }));
            }

            return el('div', { className: 'voice-block-editor voice-block-preview' },
                el('div', { className: 'voice-block-preview-inner' },
                    el('div', {
                        className: 'voice-block-preview-player' + (previewPlayingState ? ' playing' : ''),
                        onClick: function() {
                            if (!audioRef.current) return;
                            if (previewPlayingState) {
                                audioRef.current.pause();
                            } else {
                                audioRef.current.play().catch(function() {});
                            }
                        },
                        style: { cursor: 'pointer' }
                    },
                        el('span', { className: 'voice-block-play-icon' }, previewPlayingState ? '⏸' : '▶'),
                        el('div', { className: 'voice-wave-wrap' },
                            el('div', { className: 'voice-wave-bars' }, previewWaveBars)
                        ),
                        el('span', { className: 'voice-duration-label' }, duration + '"'),
                        el('audio', {
                            src: previewUrlRef.current || '',
                            preload: 'metadata',
                            ref: audioRef,
                            onEnded: function() { setPreviewPlayingState(false); },
                            onPause: function() { setPreviewPlayingState(false); },
                            onPlay: function() { setPreviewPlayingState(true); }
                        })
                    ),
                    el('div', { className: 'voice-block-preview-actions' },
                        el(Button, {
                            isSmall: true,
                            onClick: cancelRecord
                        }, __('取消', 'voice-messages')),
                        el(Button, {
                            isPrimary: true,
                            onClick: uploadVoice
                        }, __('插入文章', 'voice-messages'))
                    )
                )
            );
        }

        // 空闲：显示录音按钮
        return el('div', { className: 'voice-block-editor', style: { width: '100%' } },
            el(Placeholder, {
                icon: micIcon,
                label: __('语音消息', 'voice-messages'),
                instructions: __('点击按钮开始录音，录制完成后将自动插入文章', 'voice-messages')
            }),
            el(Button, {
                isPrimary: true,
                onClick: startRecord
            }, __('开始录音', 'voice-messages')),
            el('div', { style: { marginTop: '12px', fontSize: '13px', color: '#757575' } },
                __('或手动输入音频地址：', 'voice-messages')
            ),
            el(TextControl, {
                type: 'url',
                value: attrs.url || '',
                placeholder: __('https://example.com/audio.webm', 'voice-messages'),
                onChange: function(val) {
                    setAttributes({ url: val });
                    if (val) setRecorderState(STATE_UPLOADED);
                },
                __next40pxDefaultSize: true,
                __nextHasNoMarginBottom: true
            })
        );
    }

    // 注册区块
    wp.blocks.registerBlockType('voice-messages/voice-block', {
        apiVersion: 3,
        title: __('语音消息', 'voice-messages'),
        description: __('插入语音消息，支持按住录音', 'voice-messages'),
        icon: micIcon,
        category: 'media',
        attributes: {
            url: {
                type: 'string',
                default: ''
            },
            audioId: {
                type: 'number',
                default: 0
            },
            duration: {
                type: 'number',
                default: 0
            }
        },
        supports: {
            html: false,
            align: true
        },

        edit: VoiceRecorder,

        // 动态区块：save 返回 null，前台由 PHP render_callback 渲染
        // attributes 保存在 Gutenberg HTML 注释序列化数据中
        save: function() {
            return null;
        }
    });

})();
