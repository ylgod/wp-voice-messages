/**
 * 微信语音消息 - 前端 JavaScript
 * 支持:评论录音、文章内播放器、波形动画
 */

(function() {
    'use strict';

    const VoiceApp = {
        // 状态
        recorder: null,
        chunks: [],
        isRecording: false,
        startTime: 0,
        timerInterval: null,
        currentContext: 'comment',

        // 预览状态
        previewBlob: null,
        previewDuration: 0,
        previewUrl: null,

        // 缓存 DOM
        dom: {},

        init() {
            this.cacheDOM();
            this.bindEvents();
            this.initArticlePlayers();
        },

        cacheDOM() {
            this.dom = {
                recordBtn: document.getElementById('voiceRecordBtn'),
                recordStatus: document.getElementById('voiceRecordStatus'),
                timer: document.getElementById('voiceTimer'),
                itemsList: document.getElementById('voiceItemsList'),
                urlsInput: document.getElementById('voiceUrls'),
                durationsInput: document.getElementById('voiceDurations'),
                commentForm: document.getElementById('commentform') ||
                             document.querySelector('.comment-form') ||
                             document.querySelector('form[action*="wp-comments-post"]') ||
                             document.querySelector('#respond form'),
            };
            console.log('[VoiceMSG] DOM cached:', this.dom);
        },

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
                    // 短按(PC 模式)
                    this.handleClick();
                }
                e.preventDefault();
            }, { passive: false });

            btn.addEventListener('touchcancel', (e) => {
                clearTimeout(pressTimer);
                if (this.isRecording) this.stopRecord();
                e.preventDefault();
            });

            // 评论表单提交 - 确保数据同步
            if (this.dom.commentForm) {
                console.log('[VoiceMSG] Found comment form, binding submit');

                // 方式1:监听 submit 事件
                this.dom.commentForm.addEventListener('submit', (e) => {
                    console.log('[VoiceMSG] Form submit event');
                    this.updateHiddenFields();
                });

                // 方式2:监听提交按钮点击(备用)
                const submitBtn = this.dom.commentForm.querySelector('input[type="submit"], button[type="submit"]');
                if (submitBtn) {
                    submitBtn.addEventListener('click', () => {
                        console.log('[VoiceMSG] Submit button clicked');
                        this.updateHiddenFields();
                    });
                }
            } else {
                console.warn('[VoiceMSG] Comment form not found!');
            }
        },

        handleClick() {
            if (this.isRecording) {
                this.stopRecord();
            } else {
                this.startRecord();
            }
        },

        // ==================== 录音 ====================

        async startRecord() {
            // 权限检查
            if (!VoiceMSG.isLoggedIn && !VoiceMSG.allowGuest) {
                alert(VoiceMSG.strNoPerm || '请登录后发送语音');
                return;
            }

            // 访客必须填写昵称和邮箱
            if (!VoiceMSG.isLoggedIn) {
                const authorInput = document.querySelector('input[name="author"]');
                const emailInput = document.querySelector('input[name="email"]');
                const author = authorInput ? authorInput.value.trim() : '';
                const email = emailInput ? emailInput.value.trim() : '';
                if (!author || !email) {
                    alert('请先填写昵称和邮箱后再发送语音');
                    // 聚焦到第一个空字段
                    if (!author && authorInput) {
                        authorInput.focus();
                    } else if (!email && emailInput) {
                        emailInput.focus();
                    }
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
        },

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

            // 等待 recorder 停止后再创建 blob
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

                console.log('[VoiceMSG] Preview created:', {
                    size: this.previewBlob.size,
                    type: this.previewBlob.type,
                    duration: this.previewDuration,
                    url: this.previewUrl
                });

                this.showPreview();
            };

            this.recorder.stop();
            this.recorder.stream.getTracks().forEach(t => t.stop());
        },

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
        },

        // ==================== 计时器 ====================

        startTimer() {
            const timerEl = this.dom.timer;
            if (!timerEl) return;

            this.timerInterval = setInterval(() => {
                const seconds = Math.floor((Date.now() - this.startTime) / 1000);
                timerEl.textContent = seconds + '"';

                // 超时自动停止
                const max = parseInt(VoiceMSG.strMaxDuration) || 60;
                if (seconds >= max) {
                    this.stopRecord();
                    alert((VoiceMSG.strTooLong || '录音最长') + max + '秒');
                }
            }, 1000);
        },

        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
        },

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
        },

        // ==================== 预览 ====================

        showPreview() {
            // blob 在 stopRecord 的 onstop 回调中创建
            if (!this.previewUrl || !this.previewBlob) {
                console.error('[VoiceMSG] showPreview: no preview data');
                return;
            }

            console.log('[VoiceMSG] Creating preview UI');
            this.createPreviewUI();
        },

        createPreviewUI() {
            // 只移除 DOM 元素,不清空 blob 数据
            const existing = document.getElementById('voicePreview');
            if (existing) existing.remove();

            const container = document.createElement('div');
            container.id = 'voicePreview';
            container.className = 'voice-preview';
            container.innerHTML = `
                <div class="voice-preview-inner">
                    <div class="voice-preview-player">
                        <audio class="voice-preview-audio" preload="auto"></audio>
                        <button type="button" class="voice-preview-play">
                            <span class="play-icon"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg></span>
                            <span class="duration">${this.previewDuration}"</span>
                        </button>
                    </div>
                    <div class="voice-preview-actions">
                        <button type="button" class="voice-preview-cancel">取消</button>
                        <button type="button" class="voice-preview-send">发送</button>
                    </div>
                </div>
            `;

            // 直接设置 audio src,避免模板字符串问题
            const audio = container.querySelector('.voice-preview-audio');
            audio.src = this.previewUrl;
            console.log('[VoiceMSG] Audio element src set to:', audio.src);

            // 插入到录音按钮后面
            const recordBtn = this.dom.recordBtn;
            if (recordBtn && recordBtn.parentNode) {
                recordBtn.parentNode.insertBefore(container, recordBtn.nextSibling);
            }

            // 绑定事件
            const playBtn = container.querySelector('.voice-preview-play');
            const cancelBtn = container.querySelector('.voice-preview-cancel');
            const sendBtn = container.querySelector('.voice-preview-send');

            // 播放/暂停
            playBtn.addEventListener('click', () => {
                console.log('[VoiceMSG] Play clicked, audio src:', audio.src);
                if (audio.paused) {
                    audio.play().catch(err => {
                        console.error('[VoiceMSG] Play failed:', err);
                        alert('播放失败:' + err.message);
                    });
                    playBtn.classList.add('playing');
                } else {
                    audio.pause();
                    audio.currentTime = 0;
                    playBtn.classList.remove('playing');
                }
            });

            audio.addEventListener('ended', () => {
                playBtn.classList.remove('playing');
            });

            // 取消
            cancelBtn.addEventListener('click', () => {
                this.removePreviewUI();
            });

            // 发送
            sendBtn.addEventListener('click', () => {
                this.confirmSend();
            });
        },

        removePreviewUI() {
            const preview = document.getElementById('voicePreview');
            if (preview) {
                preview.remove();
            }
            if (this.previewUrl) {
                URL.revokeObjectURL(this.previewUrl);
                this.previewUrl = null;
            }
            this.previewBlob = null;
            this.previewDuration = 0;
        },

        // ==================== 确认发送 ====================

        async confirmSend() {
            if (!this.previewBlob) {
                alert('录音已过期,请重新录制');
                return;
            }

            const ext = this.previewBlob.type.includes('mp4') ? 'm4a' : 'webm';
            const filename = 'voice_' + Date.now() + '.' + ext;

            const formData = new FormData();
            formData.append('audio', this.previewBlob, filename);
            formData.append('duration', this.previewDuration);
            formData.append('nonce', VoiceMSG.nonce);
            formData.append('user_agent', navigator.userAgent);

            // 显示发送中状态
            const preview = document.getElementById('voicePreview');
            if (preview) {
                preview.classList.add('sending');
                const sendBtn = preview.querySelector('.voice-preview-send');
                if (sendBtn) {
                    sendBtn.textContent = '发送中...';
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
                    // 自动创建评论
                    await this.createComment(data.url, data.duration || this.previewDuration, data.id);
                } else {
                    throw new Error(data.message || '上传失败');
                }

            } catch (err) {
                console.error('上传失败:', err);
                alert(VoiceMSG.strFailed || '发送失败,请重试');
                // 恢复按钮状态
                const preview = document.getElementById('voicePreview');
                if (preview) {
                    preview.classList.remove('sending');
                    const sendBtn = preview.querySelector('.voice-preview-send');
                    if (sendBtn) {
                        sendBtn.textContent = '发送';
                        sendBtn.disabled = false;
                    }
                }
            }
        },

        // ==================== 自动创建评论 ====================

        async createComment(voiceUrl, duration, voiceId) {
            // 获取文章ID
            const postInput = document.querySelector('input[name="comment_post_ID"]');
            const postId = postInput ? postInput.value : (VoiceMSG.postId || 0);

            if (!postId) {
                console.error('[VoiceMSG] No post ID found');
                alert('无法确定文章ID');
                return;
            }

            // 获取访客信息(如果是未登录用户)
            let author = '';
            let email = '';
            let url = '';
            if (!VoiceMSG.isLoggedIn) {
                const authorInput = document.querySelector('input[name="author"]');
                const emailInput = document.querySelector('input[name="email"]');
                author = authorInput ? authorInput.value : '';
                email = emailInput ? emailInput.value : '';
                // 尝试多种常见的网址字段 name/id(不同主题命名不同)
                const urlSelectors = [
                    'input[name="url"]',
                    'input[name="website"]',
                    'input[name="author_url"]',
                    'input[id="url"]',
                    'input[id="author-url"]',
                    'input[id="website"]',
                    'input[placeholder*="网站"][type="text"]',
                    'input[placeholder*="网址"][type="text"]',
                ];
                let urlInput = null;
                let foundSelector = null;
                for (const sel of urlSelectors) {
                    const el = document.querySelector(sel);
                    if (el) { urlInput = el; foundSelector = sel; break; }
                }
                url = urlInput ? urlInput.value : '';
                console.log('[VoiceMSG] URL debug - isLoggedIn:', VoiceMSG.isLoggedIn, 'found:', foundSelector, 'value:', url);
            }

            // 获取回复的评论ID
            const parentInput = document.querySelector('input[name="comment_parent"]');
            const parentId = parentInput ? parentInput.value : 0;

            try {
                const res = await fetch(VoiceMSG.commentUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-WP-Nonce': VoiceMSG.restNonce || ''
                    },
                    body: JSON.stringify({
                        post_id: postId,
                        voice_url: voiceUrl,
                        voice_id: voiceId,
                        duration: duration,
                        author: author,
                        email: email,
                        url: url,
                        user_agent: navigator.userAgent,
                        parent: parentId
                    })
                });

                const data = await res.json();

                if (data.success) {
                    // 无刷新插入新评论
                    this.insertCommentDOM(data);
                    this.removePreviewUI();
                } else {
                    throw new Error(data.message || '评论创建失败');
                }

            } catch (err) {
                console.error('[VoiceMSG] Comment creation failed:', err);
                alert('评论发送失败:' + err.message);
            }
        },

        // ==================== 无刷新插入评论 ====================

        insertCommentDOM(data) {
            const commentId = data.comment_id;
            const voiceUrl = data.voice_url || '';
            const duration = data.duration || this.previewDuration;
            const authorName = data.author || '访客';
            const authorUrl = data.author_url || '';
            const avatarUrl = data.avatar || '';

            // 构建语音播放器 HTML
            const waveBars = Array(8).fill(0).map((_, i) =>
                '<span style="animation-delay:' + (i * 0.08) + 's"></span>'
            ).join('');

            const playerHTML = '<div class="voice-player" data-url="' + voiceUrl + '" data-duration="' + duration + '">' +
                '<div class="voice-play-icon">▶</div>' +
                '<div class="voice-wave-wrap"><div class="voice-wave-bars">' + waveBars + '</div></div>' +
                '<span class="voice-duration-label">' + duration + '"</span>' +
                '<audio class="voice-audio-el" src="' + voiceUrl + '" preload="none"></audio>' +
                '</div>';

            // 构建评论 HTML
            const now = new Date();
            const timeStr = now.getFullYear() + '-' +
                String(now.getMonth() + 1).padStart(2, '0') + '-' +
                String(now.getDate()).padStart(2, '0') + ' ' +
                String(now.getHours()).padStart(2, '0') + ':' +
                String(now.getMinutes()).padStart(2, '0');

            const authorHtml = authorUrl
                ? '<b class="fn"><a href="' + authorUrl + '" rel="external nofollow ugc" class="url">' + authorName + '</a></b>'
                : '<b class="fn">' + authorName + '</b>';

            const commentHTML = '<li class="comment byuser comment-by-guest comment-author-' + authorName.toLowerCase().replace(/\s+/g, '-') + '" id="comment-' + commentId + '">' +
                '<article class="comment-body">' +
                '<footer class="comment-meta">' +
                '<div class="comment-author vcard">' +
                (avatarUrl ? '<img alt="" src="' + avatarUrl + '" class="avatar avatar-32 photo" width="32" height="32">' : '') +
                authorHtml +
                '</div>' +
                '<div class="comment-metadata">' +
                '<a href="#comment-' + commentId + '"><time datetime="' + now.toISOString() + '">' + timeStr + '</time></a>' +
                '</div>' +
                '</footer>' +
                '<div class="comment-content">' +
                '<div class="voice-messages-wrapper">' + playerHTML + '</div>' +
                '</div>' +
                '</article>' +
                '</li>';

            // 插入到评论列表
            const commentList = document.querySelector('.comment-list, ol.commentlist, #comments ul, .comments-area ul');
            const respond = document.getElementById('respond');

            if (commentList) {
                commentList.insertAdjacentHTML('beforeend', commentHTML);
            } else if (respond) {
                // 如果没有评论列表,创建一个
                const newList = document.createElement('ol');
                newList.className = 'comment-list';
                newList.innerHTML = commentHTML;
                respond.parentNode.insertBefore(newList, respond);
            }

            // 绑定新播放器事件
            const newPlayer = document.getElementById('comment-' + commentId);
            if (newPlayer) {
                const player = newPlayer.querySelector('.voice-player');
                const audio = newPlayer.querySelector('.voice-audio-el');
                if (player && audio) {
                    player.addEventListener('click', () => {
                        document.querySelectorAll('.voice-player.playing').forEach(p => {
                            if (p !== player) {
                                p.classList.remove('playing');
                                const a = p.querySelector('.voice-audio-el');
                                if (a) a.pause();
                            }
                        });
                        if (audio.paused) {
                            player.classList.add('playing');
                            audio.play();
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
                }
                // 滚动到新评论
                newPlayer.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // 更新评论计数
            const countEl = document.querySelector('.comments-title, h2.comments-title, .comment-count');
            if (countEl) {
                const match = countEl.textContent.match(/\d+/);
                if (match) {
                    const count = parseInt(match[0]) + 1;
                    countEl.textContent = countEl.textContent.replace(/\d+/, count);
                }
            }
        },

        // ==================== 列表管理 ====================

        addToList(url, duration, attachmentId) {
            const list = this.dom.itemsList;
            if (!list) return;

            const item = document.createElement('div');
            item.className = 'voice-player voice-item-added';
            item.dataset.url = url;
            item.dataset.id = attachmentId || '';

            const playerId = 'vc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

            item.innerHTML = this.buildPlayerHTML(url, duration, playerId) +
                '<button type="button" class="voice-del-btn" title="删除">×</button>';

            // 播放事件
            const audio = item.querySelector('.voice-audio-el');
            item.addEventListener('click', (e) => {
                if (e.target.closest('.voice-del-btn')) return;
                this.togglePlay(item, audio);
            });

            // 删除事件
            item.querySelector('.voice-del-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                item.remove();
                this.updateHiddenFields();
            });

            // 播放结束
            audio.addEventListener('ended', () => {
                item.classList.remove('playing');
            });

            audio.addEventListener('timeupdate', () => {
                const durEl = item.querySelector('.voice-duration-label');
                if (durEl && audio.duration) {
                    durEl.textContent = Math.ceil(audio.duration - audio.currentTime) + '"';
                }
            });

            list.appendChild(item);
            this.updateHiddenFields();
        },

        buildPlayerHTML(url, duration, playerId) {
            const waveBars = Array(8).fill(0).map((_, i) =>
                '<span style="animation-delay:' + (i * 0.08) + 's"></span>'
            ).join('');

            return '<div class="voice-play-icon">▶</div>' +
                '<div class="voice-wave-wrap"><div class="voice-wave-bars">' + waveBars + '</div></div>' +
                '<span class="voice-duration-label">' + duration + '"</span>' +
                '<audio class="voice-audio-el" src="' + url + '" preload="none"></audio>';
        },

        togglePlay(item, audio) {
            // 暂停其他
            document.querySelectorAll('.voice-player.playing').forEach(p => {
                if (p !== item) {
                    p.classList.remove('playing');
                    const a = p.querySelector('.voice-audio-el');
                    if (a) a.pause();
                }
            });

            if (audio.paused) {
                item.classList.add('playing');
                audio.play();
            } else {
                item.classList.remove('playing');
                audio.pause();
            }
        },

        updateHiddenFields() {
            const list = this.dom.itemsList;
            const urlsInput = this.dom.urlsInput;
            const durationsInput = this.dom.durationsInput;

            if (!list || !urlsInput) {
                console.warn('[VoiceMSG] updateHiddenFields: missing elements', { list, urlsInput });
                return;
            }

            const items = list.querySelectorAll('.voice-player');
            const urls = [];
            const durations = [];

            items.forEach(item => {
                const url = item.dataset.url;
                const durEl = item.querySelector('.voice-duration-label');
                const dur = durEl ? durEl.textContent.replace(/"/g, '').replace(/'/g, '') : '0';
                if (url) {
                    urls.push(url);
                    durations.push(dur);
                    console.log('[VoiceMSG] Found voice:', url, dur);
                }
            });

            urlsInput.value = urls.join(',');
            if (durationsInput) {
                durationsInput.value = durations.join(',');
            }

            console.log('[VoiceMSG] Updated hidden fields:', {
                urls: urlsInput.value,
                durations: durationsInput ? durationsInput.value : 'N/A'
            });
        },

        // ==================== 文章内播放器 ====================

        initArticlePlayers() {
            document.querySelectorAll('.voice-player').forEach(player => {
                // 跳过评论区域的(已在 addToList 绑定)
                if (player.closest('.voice-items-list')) return;

                const audio = player.querySelector('.voice-audio-el');
                if (!audio) return;

                player.addEventListener('click', () => {
                    // 暂停其他
                    document.querySelectorAll('.voice-player.playing').forEach(p => {
                        if (p !== player) {
                            p.classList.remove('playing');
                            const a = p.querySelector('.voice-audio-el');
                            if (a) a.pause();
                        }
                    });

                    if (audio.paused) {
                        player.classList.add('playing');
                        audio.play();
                    } else {
                        player.classList.remove('playing');
                        audio.pause();
                    }
                });

                audio.addEventListener('ended', () => {
                    player.classList.remove('playing');
                });

                audio.addEventListener('timeupdate', () => {
                    const durEl = player.querySelector('.voice-duration-label');
                    if (durEl && audio.duration) {
                        durEl.textContent = Math.ceil(audio.duration - audio.currentTime) + '"';
                    }
                });
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