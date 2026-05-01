/**
 * 微信语音消息 - 前端 JavaScript
 * 支持: 评论录音、文章内播放器、波形动画
 * v3.20 — Gutenberg 区块 useBlockProps 修复，点击区块可选中/可拖拽
 * v3.19 — 修复 Gutenberg 区块无法选中的问题（添加 useBlockProps）
 * v3.18 — 古腾堡区块预加载优化，修复首次播放无声音问题
 */

(function() {
    'use strict';

    // ==================== 单个录音实例 ====================
    class VoiceAppInstance {
        constructor(wrapper) {
            this.wrapper = wrapper;
            this.recorder = null;
            this.chunks = [];
            this.isRecording = false;
            this.startTime = 0;
            this.timerInterval = null;
            this.previewBlob = null;
            this.previewDuration = 0;
            this.previewUrl = null;
            this.uploadedVoices = []; // 实例独立

            this.dom = {};
            this.cacheDOM();
        }

        cacheDOM() {
            this.dom = {
                recordBtn: this.wrapper.querySelector('.voice-record-btn'),
                recordStatus: this.wrapper.querySelector('.voice-record-status'),
                timer: this.wrapper.querySelector('.voice-record-timer'),
                attachments: this.wrapper.querySelector('.voice-attachments'),
                urlsInput: this.wrapper.querySelector('.voice-urls-input'),
                durationsInput: this.wrapper.querySelector('.voice-durations-input'),
            };
            // 评论表单：找 wrapper 最近的 form
            this.dom.commentForm = this.wrapper.closest('form') ||
                document.getElementById('commentform') ||
                document.querySelector('.comment-form') ||
                document.querySelector('form[action*="wp-comments-post"]') ||
                document.querySelector('#respond form');
        }

        init() {
            // 不移动 DOM — CSS order 负责视觉位置
            this.bindEvents();
        }

        bindEvents() {
            const btn = this.dom.recordBtn;
            if (!btn) return;

            // PC 点击
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleClick();
            });

            // 移动端长按
            let pressTimer = null;
            let longPress = false;

            btn.addEventListener('touchstart', (e) => {
                longPress = false;
                pressTimer = setTimeout(() => {
                    longPress = true;
                    this.startRecord();
                }, 200);
                e.preventDefault();
            }, { passive: false });

            btn.addEventListener('touchend', (e) => {
                clearTimeout(pressTimer);
                if (this.isRecording && longPress) {
                    this.stopRecord();
                } else if (!longPress) {
                    this.handleClick();
                }
                e.preventDefault();
            }, { passive: false });

            btn.addEventListener('touchcancel', (e) => {
                clearTimeout(pressTimer);
                if (this.isRecording) this.stopRecord();
                e.preventDefault();
            });

            // 评论表单提交 — 同步语音数据到 hidden fields
            if (this.dom.commentForm) {
                this.dom.commentForm.addEventListener('submit', () => {
                    this.syncHiddenFields();
                });
                const submitBtn = this.dom.commentForm.querySelector('input[type="submit"], button[type="submit"]');
                if (submitBtn) {
                    submitBtn.addEventListener('click', () => {
                        this.syncHiddenFields();
                    });
                }
            }
        }

        handleClick() {
            if (this.isRecording) {
                this.stopRecord();
            } else {
                this.startRecord();
            }
        }

        // ==================== 录音 ====================

        async startRecord() {
            if (!VoiceMSG.isLoggedIn && !VoiceMSG.allowGuest) {
                alert(VoiceMSG.strNoPerm || '请登录后发送语音');
                return;
            }

            if (!VoiceMSG.isLoggedIn) {
                // 找本 wrapper 所在表单的 author/email
                const form = this.dom.commentForm;
                const authorInput = form ? form.querySelector('input[name="author"]') : null;
                const emailInput = form ? form.querySelector('input[name="email"]') : null;
                const author = authorInput ? authorInput.value.trim() : '';
                const email = emailInput ? emailInput.value.trim() : '';
                if (!author || !email) {
                    alert('请先填写昵称和邮箱后再发送语音');
                    if (!author && authorInput) authorInput.focus();
                    else if (!email && emailInput) emailInput.focus();
                    return;
                }
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 16000,
                        channelCount: 1
                    }
                });

                const mimeType = this.getSupportedMime();
                this.recorder = new MediaRecorder(stream, {
                    mimeType: mimeType,
                    audioBitsPerSecond: 32000
                });

                this.chunks = [];
                this.isRecording = true;
                this.startTime = Date.now();

                this.recorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        this.chunks.push(e.data);
                    }
                };

                this.recorder.onerror = (e) => {
                    console.error('录音错误:', e);
                    this.stopRecord(true);
                };

                this.recorder.start(100);
                this.updateUI(true);
                this.startTimer();

            } catch (err) {
                console.error('获取麦克风失败:', err);
                alert(VoiceMSG.strNoPerm || '请允许麦克风权限');
            }
        }

        stopRecord(isError = false) {
            if (!this.recorder || !this.isRecording) return;

            this.isRecording = false;
            this.updateUI(false);
            this.stopTimer();

            if (isError) {
                this.chunks = [];
                this.recorder.stop();
                this.recorder.stream.getTracks().forEach(t => t.stop());
                return;
            }

            const savedChunks = [...this.chunks];
            this.chunks = [];

            this.recorder.onstop = () => {
                const duration = Math.floor((Date.now() - this.startTime) / 1000);

                if (savedChunks.length === 0 || duration < 1) {
                    if (duration < 1) {
                        alert(VoiceMSG.strTooShort || '录音太短');
                    }
                    return;
                }

                const mimeType = this.recorder.mimeType || 'audio/webm';
                this.previewBlob = new Blob(savedChunks, { type: mimeType });
                this.previewDuration = duration;
                this.previewUrl = URL.createObjectURL(this.previewBlob);

                this.showPreview();
            };

            this.recorder.stop();
            this.recorder.stream.getTracks().forEach(t => t.stop());
        }

        getSupportedMime() {
            const types = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
                'audio/ogg;codecs=opus',
                'audio/ogg',
                'audio/wav'
            ];
            for (const type of types) {
                if (MediaRecorder.isTypeSupported(type)) return type;
            }
            return 'audio/webm';
        }

        // ==================== 计时器 ====================

        startTimer() {
            const timerEl = this.dom.timer;
            if (!timerEl) return;

            this.timerInterval = setInterval(() => {
                const seconds = Math.floor((Date.now() - this.startTime) / 1000);
                timerEl.textContent = seconds + '"';

                const max = parseInt(VoiceMSG.strMaxDuration) || 60;
                if (seconds >= max) {
                    this.stopRecord();
                    alert((VoiceMSG.strTooLong || '录音最长') + max + '秒');
                }
            }, 1000);
        }

        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
        }

        // ==================== UI 更新 ====================

        updateUI(recording) {
            const btn = this.dom.recordBtn;
            const status = this.dom.recordStatus;

            if (recording) {
                btn.classList.add('recording');
                status.classList.add('active');
                document.body.classList.add('voice-recording');
            } else {
                btn.classList.remove('recording');
                status.classList.remove('active');
                document.body.classList.remove('voice-recording');

                if (this.dom.timer) {
                    this.dom.timer.textContent = '0"';
                }
            }
        }

        // ==================== 预览（录音后先听再确认） ====================

        showPreview() {
            if (!this.previewUrl || !this.previewBlob) return;
            this.createPreviewUI();
        }

        createPreviewUI() {
            // 清理旧预览
            const existing = this.wrapper.querySelector('.voice-preview');
            if (existing) existing.remove();

            const container = document.createElement('div');
            container.className = 'voice-preview';

            const playIconSvg = '<svg viewBox="0 0 14 14" width="14" height="14"><polygon points="4,2 12,7 4,12" fill="currentColor"/></svg>';
            container.innerHTML = `
                <div class="voice-preview-inner">
                    <div class="voice-preview-player">
                        <audio class="voice-preview-audio" preload="auto"></audio>
                        <button type="button" class="voice-preview-play">
                            <span class="play-icon">${playIconSvg}</span>
                            <span class="duration">${this.previewDuration}"</span>
                        </button>
                    </div>
                    <div class="voice-preview-actions">
                        <button type="button" class="voice-preview-cancel">取消</button>
                        <button type="button" class="voice-preview-send">加入评论</button>
                    </div>
                </div>
            `;

            const audio = container.querySelector('.voice-preview-audio');
            audio.src = this.previewUrl;

            const attachments = this.dom.attachments;
            if (attachments) {
                attachments.appendChild(container);
            }

            const playBtn = container.querySelector('.voice-preview-play');
            const cancelBtn = container.querySelector('.voice-preview-cancel');
            const sendBtn = container.querySelector('.voice-preview-send');

            playBtn.addEventListener('click', () => {
                if (audio.paused) {
                    audio.play().catch(err => console.error('播放失败:', err));
                    playBtn.classList.add('playing');
                } else {
                    audio.pause();
                    audio.currentTime = 0;
                    playBtn.classList.remove('playing');
                }
            });

            audio.addEventListener('ended', () => playBtn.classList.remove('playing'));

            cancelBtn.addEventListener('click', () => {
                this.removePreviewUI();
            });

            sendBtn.addEventListener('click', () => {
                this.attachVoiceToComment();
            });
        }

        removePreviewUI() {
            const preview = this.wrapper.querySelector('.voice-preview');
            if (preview) preview.remove();
            if (this.previewUrl) {
                URL.revokeObjectURL(this.previewUrl);
                this.previewUrl = null;
            }
            this.previewBlob = null;
            this.previewDuration = 0;
        }

        // ==================== 上传语音 → 加入评论框区域 ====================

        async attachVoiceToComment() {
            if (!this.previewBlob) {
                alert('录音已过期，请重新录制');
                return;
            }

            const ext = this.previewBlob.type.includes('mp4') ? 'm4a' : 'webm';
            const filename = 'voice_' + Date.now() + '.' + ext;

            const formData = new FormData();
            formData.append('audio', this.previewBlob, filename);
            formData.append('duration', this.previewDuration);
            formData.append('nonce', VoiceMSG.nonce);
            formData.append('user_agent', navigator.userAgent);

            const preview = this.wrapper.querySelector('.voice-preview');
            if (preview) {
                preview.classList.add('sending');
                const sendBtn = preview.querySelector('.voice-preview-send');
                if (sendBtn) {
                    sendBtn.textContent = '上传中...';
                    sendBtn.disabled = true;
                }
            }

            try {
                const res = await fetch(VoiceMSG.restUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'X-WP-Nonce': VoiceMSG.restNonce || ''
                    },
                    body: formData
                });

                const data = await res.json();

                if (data.success) {
                    const voiceUrl = data.url;
                    const voiceDuration = data.duration || this.previewDuration;
                    const voiceId = data.id;

                    this.uploadedVoices.push({
                        url: voiceUrl,
                        duration: voiceDuration,
                        id: voiceId
                    });

                    this.removePreviewUI();
                    this.renderAttachedVoices();
                    this.insertVoicePlaceholder(voiceId);
                    this.syncHiddenFields();

                } else {
                    throw new Error(data.message || '上传失败');
                }

            } catch (err) {
                console.error('上传失败:', err);
                alert(VoiceMSG.strFailed || '发送失败，请重试');
                if (preview) {
                    preview.classList.remove('sending');
                    const sendBtn = preview.querySelector('.voice-preview-send');
                    if (sendBtn) {
                        sendBtn.textContent = '加入评论';
                        sendBtn.disabled = false;
                    }
                }
            }
        }

        // ==================== 评论框区域 — 已上传语音展示 ====================

        renderAttachedVoices() {
            const attachments = this.dom.attachments;
            if (!attachments) return;

            // 清除旧的已上传展示（保留预览UI）
            attachments.querySelectorAll('.voice-attached-item').forEach(el => el.remove());

            this.uploadedVoices.forEach((voice, idx) => {
                const item = document.createElement('div');
                item.className = 'voice-attached-item';
                item.dataset.index = idx;

                const waveBars = Array(8).fill(0).map((_, i) =>
                    '<span style="animation-delay:' + (i * 0.08) + 's"></span>'
                ).join('');

                const playIconSvg = '<svg viewBox="0 0 14 14" width="14" height="14"><polygon points="4,2 12,7 4,12" fill="currentColor"/></svg>';
                item.innerHTML =
                    '<div class="voice-player" data-url="' + voice.url + '" data-duration="' + voice.duration + '">' +
                    '<div class="voice-play-icon">' + playIconSvg + '</div>' +
                    '<div class="voice-wave-wrap"><div class="voice-wave-bars">' + waveBars + '</div></div>' +
                    '<span class="voice-duration-label">' + voice.duration + '"</span>' +
                    '<audio class="voice-audio-el" src="' + voice.url + '" preload="none"></audio>' +
                    '</div>' +
                    '<button type="button" class="voice-attached-remove" title="移除">×</button>';

                const player = item.querySelector('.voice-player');
                const audio = item.querySelector('.voice-audio-el');

                player.addEventListener('click', (e) => {
                    if (e.target.closest('.voice-attached-remove')) return;
                    document.querySelectorAll('.voice-player.playing').forEach(p => {
                        if (p !== player) {
                            p.classList.remove('playing');
                            const a = p.querySelector('.voice-audio-el');
                            if (a) a.pause();
                        }
                    });
                    if (audio.paused) {
                        player.classList.add('playing');
                        audio.play().catch(() => player.classList.remove('playing'));
                    } else {
                        player.classList.remove('playing');
                        audio.pause();
                    }
                });

                audio.addEventListener('ended', () => player.classList.remove('playing'));
                audio.addEventListener('timeupdate', () => {
                    const durEl = player.querySelector('.voice-duration-label');
                    if (durEl && audio.duration) {
                        durEl.textContent = Math.ceil(audio.duration - audio.currentTime) + '"';
                    }
                });

                item.querySelector('.voice-attached-remove').addEventListener('click', (e) => {
                    e.stopPropagation();
                    const removedVoice = this.uploadedVoices[idx];
                    this.uploadedVoices.splice(idx, 1);
                    this.renderAttachedVoices();
                    this.syncHiddenFields();
                    if (removedVoice && removedVoice.id) {
                        this.removeVoicePlaceholder(removedVoice.id);
                    }
                });

                attachments.appendChild(item);
            });
        }

        // ==================== 评论框占位文字 ====================

        insertVoicePlaceholder(voiceId) {
            // 找本 wrapper 最近的 textarea
            const form = this.dom.commentForm;
            const textarea = form ? form.querySelector('textarea[name="comment"], #comment') : null;
            if (!textarea) return;

            const placeholder = `🎤 语音消息`;
            const current = textarea.value.trim();
            if (current) {
                textarea.value = current + '\n' + placeholder;
            } else {
                textarea.value = placeholder;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        removeVoicePlaceholder(voiceId) {
            const form = this.dom.commentForm;
            const textarea = form ? form.querySelector('textarea[name="comment"], #comment') : null;
            if (!textarea) return;

            const placeholder = '🎤 语音消息';
            textarea.value = textarea.value.replace(placeholder, '').replace(/^\s*[\r\n]+/gm, '').trim();
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // ==================== 同步隐藏字段 ====================

        syncHiddenFields() {
            const urlsInput = this.dom.urlsInput;
            const durationsInput = this.dom.durationsInput;
            if (!urlsInput) return;

            const urls = this.uploadedVoices.map(v => v.url);
            const durations = this.uploadedVoices.map(v => v.duration);

            urlsInput.value = urls.join(',');
            if (durationsInput) {
                durationsInput.value = durations.join(',');
            }
        }
    }

    // ==================== 全局管理 ====================
    const VoiceApp = {
        instances: [],

        init() {
            const wrappers = document.querySelectorAll('.voice-comment-wrapper');
            if (wrappers.length === 0) return;

            wrappers.forEach(wrapper => {
                const instance = new VoiceAppInstance(wrapper);
                instance.init();
                this.instances.push(instance);
            });

            this.initArticlePlayers();
            this.watchCommentList();
        },

        // 解锁浏览器 AudioContext（Safari/移动端可能被挂起）
        unlockAudioContext() {
            if (this._audioContextUnlocked) return;
            
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;
                
                // 创建全局 AudioContext（单例）
                if (!this._audioContext) {
                    this._audioContext = new AudioContextClass();
                }
                
                // 如果被挂起，则恢复
                if (this._audioContext.state === 'suspended') {
                    this._audioContext.resume().then(() => {
                        this._audioContextUnlocked = true;
                    });
                } else {
                    this._audioContextUnlocked = true;
                }
            } catch (e) {
                // 静默失败
            }
        },

        // ==================== 文章内播放器（全局，跨实例）====================

        initArticlePlayers() {
            document.querySelectorAll('.voice-player').forEach(player => {
                if (player.closest('.voice-attachments')) return;
                if (player.closest('.voice-items-list')) return;
                if (player.dataset.initialized) return;

                const audio = player.querySelector('.voice-audio-el');
                if (!audio) return;

                player.dataset.initialized = '1';
                player.addEventListener('click', (e) => {
                    // 防止快速重复点击
                    if (player.dataset.clicking === '1') return;
                    player.dataset.clicking = '1';
                    setTimeout(() => player.dataset.clicking = '', 300);
                    document.querySelectorAll('.voice-player.playing').forEach(p => {
                        if (p !== player) {
                            p.classList.remove('playing');
                            const a = p.querySelector('.voice-audio-el');
                            if (a) a.pause();
                        }
                    });

                    if (audio.paused) {
                        player.classList.add('playing');
                        
                        // 解锁 AudioContext（Safari/移动端可能需要）
                        this.unlockAudioContext();
                        
                        audio.play().catch(err => {
                            player.classList.remove('playing');
                            console.error('Voice play error:', err.message, 'URL:', audio.src);
                        });
                    } else {
                        player.classList.remove('playing');
                        audio.pause();
                    }
                });

                audio.addEventListener('ended', () => player.classList.remove('playing'));
                audio.addEventListener('timeupdate', () => {
                    const durEl = player.querySelector('.voice-duration-label');
                    if (durEl && audio.duration) {
                        durEl.textContent = Math.ceil(audio.duration - audio.currentTime) + '"';
                    }
                });
            });
        },

        watchCommentList() {
            const commentList = document.querySelector('.comment-list, #comments, .comments-area, ol.commentlist, ul.commentlist');
            if (!commentList) return;

            const observer = new MutationObserver(() => {
                this.initArticlePlayers();
            });

            observer.observe(commentList, {
                childList: true,
                subtree: true
            });
        }
    };

    // 初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => VoiceApp.init());
    } else {
        VoiceApp.init();
    }

    // 暴露全局
    window.VoiceApp = VoiceApp;

})();
