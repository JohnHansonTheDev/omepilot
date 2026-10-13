// ==UserScript==
// @name         Ome.tv Customizer + Peace, Male, No-Face & Country Auto Skip + Female Auto Hi (with Pause)
// @namespace    http://tampermonkey.net/
// @version      7.2
// @description  Drag/resize, dark mode, hotkeys, automatic peace-sign skip, remote face/gender skip, frozen/black camera skip, country blocklist skip, auto-hi with auto-pause, skip counter, face save mode gallery, and local server video restart trigger on manual and automatic skips.
// @author       You
// @match        *://ome.tv/*
// @match        *://*.ome.tv/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ome.tv
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js
// @require      https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function() {
    'use strict';

    // Prevent double-load (Tampermonkey iframe runs + re-injects = duplicate
    // ML loops + observers = "page is slowing down your browser").
    if (window._omeCustomizerLoaded) return;
    window._omeCustomizerLoaded = true;

    // ==========================================
    // 1. SETTINGS & LAYOUT MANAGEMENT
    // ==========================================
    const defaultSettings = {
        masterEnable: true,
        darkMode: true,
        allowTools: true,
        skipKey: 'd',
        stopKey: 's',
        pauseKey: 'x',

        // Peace-sign settings
        peaceAutoSkip: false,
        showPeacePanel: true,
        peaceRequiredFrames: 7,
        peaceCooldown: 2500,
        detectionInterval: 120,

        // Male auto-skip settings
        skipMaleAuto: true,
        maleConfidenceThreshold: 0.65,
        maleRequiredFrames: 3,
        maleCooldown: 2500,

        // No-Face auto-skip settings
        skipNoFaceAuto: true,
        noFaceRequiredSeconds: 3,
        noFaceCooldown: 2500,

        // Frozen/Hanging camera settings
        skipFrozenAuto: true,
        frozenRequiredSeconds: 3.5,
        frozenCooldown: 3000,

        // Black-screen camera settings (lens covered / black feed)
        skipBlackAuto: true,
        blackLuminanceThreshold: 12,
        blackRequiredSeconds: 2.5,
        blackCooldown: 3000,

        // Country Auto-Skip settings
        skipCountryAuto: false,
        skippedCountries: {}, // e.g. { "US": true, "GR": true }

        // Custom Female Greeting
        femaleGreetingMessage: 'hi',
        pauseOnFemale: false,

        // Save Mode
        saveMode: false,

        // Restart Video Server Request
        restartVideoEnabled: false
    };

    let waitingForRemoteSkip = false;
    let totalGeneralSkips = 0;
    let capturedScreenshots = [];
    let currentPartnerId = 0;
    let capturedPartnerIds = new Set();
    let toastTimeout = null;
    let currentPartnerTexts = [];
    let currentPartnerSentTexts = [];
    let settings = { ...defaultSettings, ...(JSON.parse(localStorage.getItem('ometv_custom_settings')) || {}) };
    let savedLayouts = JSON.parse(localStorage.getItem('ometv_video_layouts')) || {};
    let currentCamera = null;

    function saveSettings(newSettings) {
        // Preserve blocklist when callers (main Save button) omit it — otherwise
        // opening Settings + Save wipes your checked countries.
        if (!newSettings.skippedCountries && settings.skippedCountries) {
            newSettings.skippedCountries = settings.skippedCountries;
        }
        settings = { ...defaultSettings, ...newSettings };
        localStorage.setItem('ometv_custom_settings', JSON.stringify(settings));
        applySettings();
    }

    function saveVideoLayout(key, layout) {
        savedLayouts[key] = layout;
        localStorage.setItem('ometv_video_layouts', JSON.stringify(savedLayouts));
    }

    function clearVideoLayouts() {
        localStorage.removeItem('ometv_video_layouts');
        savedLayouts = {};
        document.querySelectorAll('video').forEach(video => {
            const container = video.parentElement;
            if (container) resetContainerStyle(container, video);
        });
    }

    function resetContainerStyle(container, video) {
        container.style.position = ''; container.style.left = ''; container.style.top = '';
        container.style.width = ''; container.style.height = ''; container.style.zIndex = '';
        container.style.margin = '';
        if (video) { video.style.width = ''; video.style.height = ''; video.style.objectFit = ''; }
    }

    function resetPartnerState() {
        hasSentHi = false;
        waitingForRemoteSkip = false;
        noFaceStartTime = 0;
        remoteMaleFrames = 0;
        frozenStartTime = 0;
        lastFrameData = null;
        blackStartTime = 0;
        currentPartnerTexts = [];
        currentPartnerSentTexts = [];
    }

    function updateText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function showToast(message, color = '#fff') {
        let toast = document.getElementById('ome-toast-notification');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ome-toast-notification';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.color = color;
        toast.classList.add('show');

        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, 1500);
    }

    function triggerServerRestart() {
        if (settings.restartVideoEnabled) {
            fetch('http://localhost:9999', { method: 'GET', mode: 'no-cors' }).catch(() => {});
        }
    }

    // ==========================================
    // 2. STYLES
    // ==========================================
    const customCSS = `
        html.ome-dark-mode, body.ome-dark-mode, body.ome-dark-mode #app, body.ome-dark-mode #roulette,
        body.ome-dark-mode .video-container, body.ome-dark-mode .chat-container, body.ome-dark-mode .chat,
        body.ome-dark-mode .chat__body, body.ome-dark-mode .chat__messages, body.ome-dark-mode .chat__textfield,
        body.ome-dark-mode .chat__textarea-container, body.ome-dark-mode .popup, body.ome-dark-mode .popup-gray,
        body.ome-dark-mode .popup-container, body.ome-dark-mode .popup-content, body.ome-dark-mode .popup-header,
        body.ome-dark-mode .popup-footer, body.ome-dark-mode .country-filter-popup, body.ome-dark-mode .gender-selector__popup,
        body.ome-dark-mode .language-selector__popup {
            background: #121212 !important; background-color: #121212 !important; color: #e0e0e0 !important;
        }
        body.ome-dark-mode .message-bubble, body.ome-dark-mode .country-filter-popup__country,
        body.ome-dark-mode .language-selector__popup-item, body.ome-dark-mode .gender-selector__popup-item,
        body.ome-dark-mode .btn-gray .btn__bg {
            background-color: #1e1e1e !important; color: #e0e0e0 !important; border-color: #333 !important;
        }
        body.ome-dark-mode input#chat-text, body.ome-dark-mode .chat__textarea {
            background-color: #252525 !important; color: #ffffff !important; border: 1px solid #444 !important;
        }
        body.ome-dark-mode .tr, body.ome-dark-mode label, body.ome-dark-mode p, body.ome-dark-mode span, body.ome-dark-mode div { color: #e0e0e0; }

        #ome-settings-btn { position: fixed; bottom: 20px; left: 20px; background: #ff5e00; color: white; border: none; border-radius: 50%; width: 45px; height: 45px; font-size: 20px; cursor: pointer; z-index: 999999; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.2s; }
        #ome-settings-btn:hover { transform: scale(1.1); }
        #ome-settings-modal { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #222 !important; color: #fff !important; padding: 25px; border-radius: 12px; z-index: 1000000; box-shadow: 0 10px 30px rgba(0,0,0,0.7); font-family: Arial, sans-serif; width: 380px; border: 1px solid #444; max-height: 85vh; overflow-y: auto; }
        #ome-settings-modal h3 { margin-top: 0; color: #ff5e00; border-bottom: 1px solid #444; padding-bottom: 10px; }
        .ome-setting-row { margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
        .ome-setting-row input[type="text"] { width: 40px; text-align: center; background: #333; border: 1px solid #555; color: white; border-radius: 4px; padding: 4px; }
        .ome-setting-row input[type="range"] { width: 120px; cursor: pointer; }
        .ome-full-btn { width: 100%; padding: 8px; margin-top: 5px; margin-bottom: 15px; background: #e65100; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: background 0.2s; }
        .ome-full-btn:hover { background: #ff5e00; }
        .ome-modal-buttons { display: flex; justify-content: space-between; margin-top: 15px; border-top: 1px solid #444; padding-top: 15px; }
        .ome-modal-buttons button { padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
        #ome-save-btn { background: #28a745; color: white; }
        #ome-close-btn { background: #dc3545; color: white; }

        /* Country Modal Style */
        #ome-country-modal { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #222 !important; color: #fff !important; padding: 20px; border-radius: 12px; z-index: 2000000; box-shadow: 0 10px 30px rgba(0,0,0,0.8); font-family: Arial, sans-serif; width: 420px; max-height: 80vh; border: 1px solid #444; display: flex; flex-direction: column; }
        #ome-country-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; max-height: 50vh; overflow-y: auto; background: #181818; padding: 10px; border-radius: 6px; border: 1px solid #333; margin-top: 10px; margin-bottom: 15px; }
        .ome-country-item { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; user-select: none; }
        .ome-country-item input { cursor: pointer; }

        .ome-video-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1000000; opacity: 0; transition: opacity 0.2s ease-in-out; display: none; }
        body.ome-allow-tools .ome-video-overlay { display: block; }
        *:hover > .ome-video-overlay { opacity: 1; }
        .ome-tool-btn { pointer-events: auto; position: absolute; background: rgba(0,0,0,0.7); color: white; width: 32px; height: 32px; display: flex; justify-content: center; align-items: center; border-radius: 6px; cursor: pointer; user-select: none; font-size: 18px; box-shadow: 0 2px 4px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); }
        .ome-tool-btn:hover { background: #ff5e00; border-color: white; }
        .ome-btn-move { top: 8px; left: 8px; cursor: move; }
        .ome-btn-reset { top: 8px; left: 48px; font-size: 16px; }
        .ome-btn-resize { bottom: 8px; right: 8px; cursor: nwse-resize; font-size: 16px; }

        #ome-peace-panel { position: fixed; right: 15px; bottom: 15px; width: 280px; background: rgba(10,10,10,.94); color: #ddd; border: 1px solid #444; border-radius: 10px; padding: 12px; z-index: 999999999; font-family: Consolas, monospace; font-size: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.6); backdrop-filter: blur(6px); }
        #ome-peace-panel .peace-title { font-size: 14px; font-weight: bold; color: #ff5e00; margin-bottom: 8px; cursor: move; }
        #ome-peace-status { padding: 6px; border-radius: 5px; background: #222; margin-bottom: 8px; font-weight: bold; }
        #ome-peace-status.detected { background: #123d20; color: #55ff88; }
        #ome-peace-status.searching { color: #aaa; }
        .ome-peace-row { display: flex; justify-content: space-between; margin: 4px 0; }
        #ome-peace-log { margin-top: 8px; height: 105px; overflow-y: auto; background: #080808; border: 1px solid #333; padding: 5px; border-radius: 4px; font-size: 10px; line-height: 1.4; }
        .ome-peace-controls { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
        .ome-peace-controls button { flex: 1 1 30%; border: 0; border-radius: 4px; padding: 5px; cursor: pointer; color: white; background: #333; }
        .ome-peace-controls button:hover { background: #555; }
        #ome-peace-toggle.active { background: #e65100; }

        #ome-toast-notification { position: fixed; top: 30px; left: 50%; transform: translateX(-50%); padding: 12px 24px; background: rgba(20,20,20,.9); color: #fff; font-size: 18px; font-weight: bold; font-family: sans-serif; border: 2px solid #444; border-radius: 8px; z-index: 9999999999; pointer-events: none; opacity: 0; box-shadow: 0 5px 15px rgba(0,0,0,.5); transition: opacity .6s ease-out; }
        #ome-toast-notification.show { opacity: 1; transition: opacity .1s ease-in; }

        #ome-gallery-modal { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: #1a1a1a !important; color: #fff !important; padding: 20px; border-radius: 12px; z-index: 1000000; box-shadow: 0 10px 30px rgba(0,0,0,.8); font-family: Arial, sans-serif; width: 80vw; max-width: 700px; max-height: 80vh; border: 1px solid #444; overflow-y: auto; }
        #ome-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-top: 15px; margin-bottom: 15px; max-height: 50vh; overflow-y: auto; padding: 5px; }
        .ome-gallery-card { background: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; align-items: center; }
        .ome-gallery-card img { width: 100%; height: 100px; object-fit: cover; border-radius: 4px; cursor: pointer; transition: opacity 0.2s; }
        .ome-gallery-card img:hover { opacity: 0.85; }
        .ome-gallery-card span { font-size: 10px; color: #aaa; margin: 4px 0; }
        .ome-gallery-card button { width: 100%; font-size: 11px; padding: 3px; background: #e65100; color: white; border: none; border-radius: 3px; cursor: pointer; }
        .ome-gallery-card button:hover { background: #ff5e00; }
        .ome-gallery-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: bold; color: #fff; background: rgba(255,255,255,.08); border: 1px solid #555; border-radius: 20px; padding: 2px 8px 2px 2px; margin-top: 6px; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .ome-gallery-flag img { width: 22px !important; height: 15px !important; object-fit: cover; border-radius: 3px; cursor: default; }

        #ome-image-viewer-modal { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.9); z-index: 2000000; justify-content: center; align-items: center; cursor: pointer; flex-direction: column; }
        #ome-viewer-img { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: 6px; box-shadow: 0 5px 30px rgba(0,0,0,0.9); border: 1px solid #444; }
        #ome-viewer-caption { color: #fff; margin-top: 12px; font-family: Arial, sans-serif; font-size: 14px; text-align: center; background: rgba(0,0,0,0.6); padding: 6px 12px; border-radius: 4px; border: 1px solid #333; }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = customCSS;
    document.head.appendChild(styleEl);

    function applySettings() {
        if (settings.darkMode) {
            document.documentElement.classList.add('ome-dark-mode');
            document.body.classList.add('ome-dark-mode');
        } else {
            document.documentElement.classList.remove('ome-dark-mode');
            document.body.classList.remove('ome-dark-mode');
        }
        document.body.classList.toggle('ome-allow-tools', settings.allowTools);
        const panel = document.getElementById('ome-peace-panel');
        if (panel) panel.style.display = settings.showPeacePanel ? 'block' : 'none';
    }

    // ==========================================
    // SUPPORTED COUNTRY DATA LIST
    // ==========================================
    const SUPPORTED_COUNTRIES = [
        { code: 'US', name: 'United States' },
        { code: 'GB', name: 'United Kingdom' },
        { code: 'CA', name: 'Canada' },
        { code: 'AU', name: 'Australia' },
        { code: 'DE', name: 'Germany' },
        { code: 'FR', name: 'France' },
        { code: 'IT', name: 'Italy' },
        { code: 'ES', name: 'Spain' },
        { code: 'BR', name: 'Brazil' },
        { code: 'MX', name: 'Mexico' },
        { code: 'IN', name: 'India' },
        { code: 'TR', name: 'Turkey' },
        { code: 'PL', name: 'Poland' },
        { code: 'RU', name: 'Russia' },
        { code: 'UA', name: 'Ukraine' },
        { code: 'GR', name: 'Greece' },
        { code: 'NL', name: 'Netherlands' },
        { code: 'SE', name: 'Sweden' },
        { code: 'NO', name: 'Norway' },
        { code: 'DK', name: 'Denmark' },
        { code: 'FI', name: 'Finland' },
        { code: 'CH', name: 'Switzerland' },
        { code: 'AT', name: 'Austria' },
        { code: 'RO', name: 'Romania' },
        { code: 'AR', name: 'Argentina' },
        { code: 'CO', name: 'Colombia' },
        { code: 'CL', name: 'Chile' },
        { code: 'PE', name: 'Peru' },
        { code: 'JP', name: 'Japan' },
        { code: 'KR', name: 'South Korea' },
        { code: 'CN', name: 'China' },
        { code: 'PH', name: 'Philippines' },
        { code: 'ID', name: 'Indonesia' },
        { code: 'VN', name: 'Vietnam' },
        { code: 'TH', name: 'Thailand' },
        { code: 'MY', name: 'Malaysia' },
        { code: 'ZA', name: 'South Africa' },
        { code: 'EG', name: 'Egypt' },
        { code: 'SA', name: 'Saudi Arabia' },
        { code: 'AE', name: 'UAE' },
        { code: 'IL', name: 'Israel' },
        { code: 'IE', name: 'Ireland' },
        { code: 'PT', name: 'Portugal' },
        { code: 'CZ', name: 'Czech Republic' },
        { code: 'HU', name: 'Hungary' },
        { code: 'BE', name: 'Belgium' },
        { code: 'NZ', name: 'New Zealand' },
        { code: 'HR', name: 'Croatia' },
        { code: 'RS', name: 'Serbia' },
        { code: 'BG', name: 'Bulgaria' },
        { code: 'AL', name: 'Albania' }
    ];

    // ==========================================
    // 3. SETTINGS & COUNTRY UI PANEL
    // ==========================================
    function createCountryUI() {
        if (document.getElementById('ome-country-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'ome-country-modal';

        let html = `
            <h3 style="margin-top: 0; color: #ff5e00; border-bottom: 1px solid #444; padding-bottom: 8px;">🌍 Select Countries to Auto-Skip</h3>
            <div style="font-size: 11px; color: #aaa; margin-bottom: 5px;">Check any country you want to automatically skip when matched:</div>
            <div style="display: flex; gap: 10px; margin-bottom: 8px;">
                <button type="button" id="ome-country-select-all" style="font-size:11px; padding:3px 8px; cursor:pointer; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">Select All</button>
                <button type="button" id="ome-country-clear-all" style="font-size:11px; padding:3px 8px; cursor:pointer; background:#333; color:#fff; border:1px solid #555; border-radius:4px;">Clear All</button>
            </div>
            <div id="ome-country-list">
        `;

        SUPPORTED_COUNTRIES.sort((a,b) => a.name.localeCompare(b.name)).forEach(c => {
            const isChecked = settings.skippedCountries[c.code] ? 'checked' : '';
            html += `
                <label class="ome-country-item">
                    <input type="checkbox" value="${c.code}" ${isChecked}>
                    <span>${c.name} (${c.code})</span>
                </label>
            `;
        });

        // Custom codes already saved (not in the built-in list) — keep them visible
        const knownCodes = new Set(SUPPORTED_COUNTRIES.map(c => c.code));
        const customCodes = Object.keys(settings.skippedCountries || {}).filter(k => /^[A-Za-z]{2}$/.test(k) && !knownCodes.has(k.toUpperCase()));
        customCodes.forEach(code => {
            const up = code.toUpperCase();
            const isChecked = settings.skippedCountries[code] || settings.skippedCountries[up] ? 'checked' : '';
            html += `
                <label class="ome-country-item ome-custom-country">
                    <input type="checkbox" value="${up}" ${isChecked}>
                    <span>Custom (${up})</span>
                </label>
            `;
        });

        html += `
            </div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <input type="text" id="ome-custom-code" maxlength="2" placeholder="XX" style="width: 50px; text-align: center; text-transform: uppercase; background: #333; border: 1px solid #555; color: white; border-radius: 4px; padding: 4px;">
                <button type="button" id="ome-custom-add" style="font-size:11px; padding: 4px 10px; cursor: pointer; background: #00838f; color: #fff; border: none; border-radius: 4px; font-weight: bold;">+ Add custom code</button>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid #444; padding-top: 10px;">
                <button id="ome-country-close" style="background: #dc3545; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-weight: bold;">Done</button>
            </div>
        `;
        modal.innerHTML = html;
        document.body.appendChild(modal);

        modal.querySelector('#ome-country-close').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        modal.querySelector('#ome-country-select-all').addEventListener('click', () => {
            modal.querySelectorAll('#ome-country-list input[type="checkbox"]').forEach(chk => {
                chk.checked = true;
                settings.skippedCountries[chk.value] = true;
            });
            saveSettings(settings);
        });

        modal.querySelector('#ome-country-clear-all').addEventListener('click', () => {
            modal.querySelectorAll('#ome-country-list input[type="checkbox"]').forEach(chk => {
                chk.checked = false;
                settings.skippedCountries[chk.value] = false;
            });
            saveSettings(settings);
        });

        const bindCountryCheckbox = (chk) => {
            chk.addEventListener('change', (e) => {
                settings.skippedCountries[e.target.value] = e.target.checked;
                saveSettings(settings);
            });
        };
        modal.querySelectorAll('#ome-country-list input[type="checkbox"]').forEach(bindCountryCheckbox);

        modal.querySelector('#ome-custom-add').addEventListener('click', () => {
            const inp = modal.querySelector('#ome-custom-code');
            const code = (inp.value || '').trim().toUpperCase();
            if (!/^[A-Z]{2}$/.test(code)) {
                alert('Enter a 2-letter country code (e.g. AL, GR, XK).');
                return;
            }
            settings.skippedCountries[code] = true;
            saveSettings(settings);
            const list = modal.querySelector('#ome-country-list');
            if (list && !list.querySelector(`input[value="${code}"]`)) {
                const label = document.createElement('label');
                label.className = 'ome-country-item ome-custom-country';
                label.innerHTML = `<input type="checkbox" value="${code}" checked> <span>Custom (${code})</span>`;
                list.appendChild(label);
                bindCountryCheckbox(label.querySelector('input'));
            }
            inp.value = '';
        });
    }

    function createSettingsUI() {
        if (document.getElementById('ome-settings-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'ome-settings-btn';
        btn.innerHTML = '⚙️';
        document.body.appendChild(btn);

        const modal = document.createElement('div');
        modal.id = 'ome-settings-modal';
        modal.innerHTML = `
            <h3>Ome.tv Settings</h3>
            <div class="ome-setting-row"><label>Dark Mode</label><input type="checkbox" id="ome-chk-dark" ${settings.darkMode ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>Enable Drag & Resize Tools</label><input type="checkbox" id="ome-chk-tools" ${settings.allowTools ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>Skip / Start Key</label><input type="text" id="ome-inp-skip" maxlength="1" value="${settings.skipKey}"></div>
            <div class="ome-setting-row"><label>Stop Key</label><input type="text" id="ome-inp-stop" maxlength="1" value="${settings.stopKey}"></div>
            <div class="ome-setting-row"><label>Pause / Resume Key</label><input type="text" id="ome-inp-pause" maxlength="1" value="${settings.pauseKey}"></div>
            <div class="ome-setting-row"><label>📸 Save Mode (Face Snap)</label><input type="checkbox" id="ome-chk-savemode" ${settings.saveMode ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>🔄 Restart Video on Skip (9999)</label><input type="checkbox" id="ome-chk-restartvideo" ${settings.restartVideoEnabled ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>✌️ Peace Auto Skip</label><input type="checkbox" id="ome-chk-peace" ${settings.peaceAutoSkip ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>♂️ Male Auto Skip</label><input type="checkbox" id="ome-chk-male" ${settings.skipMaleAuto ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>😶 No Face Auto Skip</label><input type="checkbox" id="ome-chk-noface" ${settings.skipNoFaceAuto ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label style="font-size: 13px; color: #aaa;">↳ No-Face Time: <span id="ome-val-noface-time">${settings.noFaceRequiredSeconds}</span>s</label><input type="range" id="ome-rng-noface-time" min="1" max="10" step="1" value="${settings.noFaceRequiredSeconds}"></div>
            <div class="ome-setting-row"><label>💬 Female Auto-Msg</label><input type="text" id="ome-inp-hi" value="${settings.femaleGreetingMessage}" style="width: 100px; text-align: left;"></div>
            <div class="ome-setting-row"><label>⏸️ Pause after Female</label><input type="checkbox" id="ome-chk-pausefemale" ${settings.pauseOnFemale ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>❄️ Frozen Camera Skip</label><input type="checkbox" id="ome-chk-frozen" ${settings.skipFrozenAuto ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>⬛ Black Screen Skip</label><input type="checkbox" id="ome-chk-black" ${settings.skipBlackAuto ? 'checked' : ''}></div>
            <div class="ome-setting-row"><label>🌍 Country Auto Skip</label><input type="checkbox" id="ome-chk-country" ${settings.skipCountryAuto ? 'checked' : ''}></div>
            <button id="ome-open-country-btn" type="button" class="ome-full-btn" style="background: #00838f;">🌍 Configure Country Skip List</button>
            <div class="ome-setting-row"><label>Show Debug Panel</label><input type="checkbox" id="ome-chk-panel" ${settings.showPeacePanel ? 'checked' : ''}></div>
            <button id="ome-reset-layout-btn" type="button" class="ome-full-btn">↺ Reset Video Positions</button>
            <div class="ome-modal-buttons"><button id="ome-close-btn">Cancel</button><button id="ome-save-btn">Save</button></div>
        `;
        document.body.appendChild(modal);
        createCountryUI();

        btn.addEventListener('click', () => { modal.style.display = 'block'; });
        modal.querySelector('#ome-close-btn').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.querySelector('#ome-open-country-btn').addEventListener('click', () => {
            const cModal = document.getElementById('ome-country-modal');
            if (cModal) cModal.style.display = 'flex';
        });
        modal.querySelector('#ome-rng-noface-time').addEventListener('input', (e) => { modal.querySelector('#ome-val-noface-time').textContent = e.target.value; });
        modal.querySelector('#ome-reset-layout-btn').addEventListener('click', () => { clearVideoLayouts(); alert('Reset successful.'); });

        modal.querySelector('#ome-save-btn').addEventListener('click', () => {
            saveSettings({
                masterEnable: settings.masterEnable,
                darkMode: modal.querySelector('#ome-chk-dark').checked,
                allowTools: modal.querySelector('#ome-chk-tools').checked,
                skipKey: modal.querySelector('#ome-inp-skip').value.toLowerCase() || 'd',
                stopKey: modal.querySelector('#ome-inp-stop').value.toLowerCase() || 's',
                pauseKey: modal.querySelector('#ome-inp-pause').value.toLowerCase() || 'x',
                saveMode: modal.querySelector('#ome-chk-savemode').checked,
                restartVideoEnabled: modal.querySelector('#ome-chk-restartvideo').checked,
                peaceAutoSkip: modal.querySelector('#ome-chk-peace').checked,
                skipMaleAuto: modal.querySelector('#ome-chk-male').checked,
                skipNoFaceAuto: modal.querySelector('#ome-chk-noface').checked,
                noFaceRequiredSeconds: parseInt(modal.querySelector('#ome-rng-noface-time').value, 10),
                skipFrozenAuto: modal.querySelector('#ome-chk-frozen').checked,
                skipBlackAuto: modal.querySelector('#ome-chk-black').checked,
                skipCountryAuto: modal.querySelector('#ome-chk-country').checked,
                skippedCountries: settings.skippedCountries,
                showPeacePanel: modal.querySelector('#ome-chk-panel').checked,
                femaleGreetingMessage: modal.querySelector('#ome-inp-hi').value || 'hi',
                pauseOnFemale: modal.querySelector('#ome-chk-pausefemale').checked
            });
            modal.style.display = 'none';
        });
    }

    // ==========================================
    // 4. DRAG, RESIZE & PERSISTENT ENGINE
    // ==========================================
    function getVideoKey(container, video) {
        const isLocal = video.muted || video.hasAttribute('muted') || (container.id && container.id.toLowerCase().includes('local')) || (container.className && typeof container.className === 'string' && container.className.toLowerCase().includes('local'));
        return isLocal ? 'ometv_local_camera_layout' : (container.id ? 'ometv_' + container.id : 'ometv_remote_video_layout');
    }

    function setupVideoTools() {
        const observer = new MutationObserver(() => {
            document.querySelectorAll('video').forEach(video => {
                if (video.dataset.omeToolsAttached) return;
                const container = video.parentElement;
                if (!container || container.tagName === 'BODY') return;

                video.dataset.omeToolsAttached = 'true';
                const videoKey = getVideoKey(container, video);
                const isLocal = videoKey === 'ometv_local_camera_layout';
                const targetZIndex = isLocal ? '999999' : '999990';

                if (window.getComputedStyle(container).position === 'static') container.style.position = 'relative';

                if (savedLayouts[videoKey]) {
                    const layout = savedLayouts[videoKey];
                    container.style.position = 'fixed'; container.style.left = layout.left; container.style.top = layout.top;
                    container.style.width = layout.width; container.style.height = layout.height; container.style.zIndex = targetZIndex; container.style.margin = '0';
                    video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'cover';
                }

                const toolsUI = document.createElement('div');
                toolsUI.className = 'ome-video-overlay';
                toolsUI.innerHTML = `<div class="ome-tool-btn ome-btn-move" title="Drag to move">🕂</div><div class="ome-tool-btn ome-btn-reset" title="Reset">↺</div><div class="ome-tool-btn ome-btn-resize" title="Drag to resize">⇲</div>`;
                container.appendChild(toolsUI);

                let isDragging = false, isResizing = false, startX, startY, startWidth, startHeight;

                toolsUI.querySelector('.ome-btn-move').addEventListener('mousedown', (e) => {
                    e.preventDefault(); isDragging = true;
                    const rect = container.getBoundingClientRect();
                    if (container.style.position !== 'fixed') { container.style.position = 'fixed'; container.style.left = rect.left + 'px'; container.style.top = rect.top + 'px'; container.style.width = rect.width + 'px'; container.style.height = rect.height + 'px'; container.style.zIndex = targetZIndex; container.style.margin = '0'; }
                    startX = e.clientX - container.getBoundingClientRect().left; startY = e.clientY - container.getBoundingClientRect().top;
                    document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp);
                });

                function onMouseMove(e) {
                    if (!isDragging) return;
                    container.style.left = (e.clientX - startX) + 'px'; container.style.top = (e.clientY - startY) + 'px';
                }

                toolsUI.querySelector('.ome-btn-resize').addEventListener('mousedown', (e) => {
                    e.preventDefault(); isResizing = true;
                    const rect = container.getBoundingClientRect(); startWidth = rect.width; startHeight = rect.height; startX = e.clientX; startY = e.clientY;
                    document.addEventListener('mousemove', onResizeMove); document.addEventListener('mouseup', onMouseUp);
                });

                function onResizeMove(e) {
                    if (!isResizing) return;
                    container.style.width = Math.max(150, startWidth + (e.clientX - startX)) + 'px';
                    container.style.height = Math.max(100, startHeight + (e.clientY - startY)) + 'px';
                    video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'cover';
                }

                function onMouseUp() {
                    if (isDragging || isResizing) saveVideoLayout(videoKey, { left: container.style.left, top: container.style.top, width: container.style.width, height: container.style.height });
                    isDragging = false; isResizing = false;
                    document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mousemove', onResizeMove); document.removeEventListener('mouseup', onMouseUp);
                }

                toolsUI.querySelector('.ome-btn-reset').addEventListener('click', (e) => {
                    e.preventDefault(); delete savedLayouts[videoKey]; localStorage.setItem('ometv_video_layouts', JSON.stringify(savedLayouts)); resetContainerStyle(container, video);
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ==========================================
    // CHAT MESSAGE OBSERVER & COUNTRY DETECTOR
    // ==========================================
    let lastCountryCheckedPartnerId = -1;
    let lastCountryCheckedCode = '';
    let lastLoggedCountryKey = '';

    // Direct lookup for <span class="tr-country" data-tr="GR">Greece</span>
    // This element lives OUTSIDE .message-bubble, so the old bubble-only scan missed it.
    // Kept ultra-cheap: single querySelector, no full-DOM scans.
    let _lastTrText = '';
    let _lastTrCache = null;
    function getDirectCountry() {
        const el = document.querySelector('.tr-country');
        if (!el) { _lastTrText = ''; _lastTrCache = null; return null; }
        // Hidden placeholder badge (home screen, not chatting) — ignore it.
        if (el.offsetParent === null) return null;
        const raw = (el.textContent || '') + '|' + (el.getAttribute('data-tr') || '');
        if (raw === _lastTrText && _lastTrCache) return _lastTrCache;
        _lastTrText = raw;
        const attr = (el.getAttribute('data-tr') || '').trim();
        const name = cleanCountryText(el.textContent);
        let code = '';
        if (/^[A-Za-z]{2}$/.test(attr)) code = attr.toUpperCase();
        else if (name) code = countryNameToCode(name);
        if (!code && !name) return null;
        _lastTrCache = { countryCode: code, countryName: name || code };
        return _lastTrCache;
    }

    function ensureCountryPanelRow() {
        if (document.getElementById('ome-peace-country')) return;
        const statusEl = document.getElementById('ome-peace-status');
        if (!statusEl || !statusEl.parentElement) return;
        const row = document.createElement('div');
        row.className = 'ome-peace-row';
        row.innerHTML = '<span>Country:</span><span id="ome-peace-country" style="font-weight:bold;">--</span>';
        statusEl.parentElement.insertBefore(row, statusEl.nextSibling);
    }

    function checkCountryFilter() {
        ensureCountryPanelRow();
        // No active stranger video = not chatting yet. Don't report/skip anything
        // (the badge can hold a placeholder like Albania on the home screen).
        let chatting = false;
        try { chatting = !!findRemoteVideo(); } catch (e) { chatting = false; }
        if (!chatting) {
            _lastTrText = ''; _lastTrCache = null;
            lastLoggedCountryKey = '';
            updateText('ome-peace-country', '--');
            return;
        }
        // Cheap path only: just .tr-country. Skip the expensive bubble scan here
        // (the poller + observer call this often — bubble scan is fallback only).
        let info = null;
        try { info = getDirectCountry(); } catch (e) { info = null; }
        if (!info) {
            updateText('ome-peace-country', '--');
            return;
        }
        const countryCode = ((info && info.countryCode) || '').toUpperCase();
        const countryName = (info && info.countryName) || countryCode || '';

        // Always show in console + panel so you know what was grabbed.
        if (countryCode || countryName) {
            const logKey = currentPartnerId + '|' + countryCode;
            if (logKey !== lastLoggedCountryKey) {
                lastLoggedCountryKey = logKey;
                const msg = `[OmeTV] Connected country: ${countryName} (${countryCode}) | partner #${currentPartnerId}`;
                console.log(msg);
                peaceLog(`🌍 Connected: ${countryName} (${countryCode})`, 'default');
                updateText('ome-peace-country', `${countryName} (${countryCode})`);
            }
        } else {
            updateText('ome-peace-country', '--');
        }

        if (!settings.masterEnable) { console.log('[OmeTV] Country check: master PAUSED, not skipping'); return; }
        if (!settings.skipCountryAuto) { console.log('[OmeTV] Country check: skipCountryAuto OFF, not skipping'); return; }
        if (!countryCode) return;
        if (window._omeSkipCooldownUntil && Date.now() < window._omeSkipCooldownUntil) return;
        // Same partner + same code = already handled. Same partner + DIFFERENT code
        // (badge loads late: Albania → Greece) must be re-evaluated, otherwise
        // blocked countries slip through.
        if (currentPartnerId === lastCountryCheckedPartnerId && countryCode === lastCountryCheckedCode) return;

        console.log(`[OmeTV] Country check: ${countryCode} blocklist=${!!settings.skippedCountries[countryCode]} partner=${currentPartnerId}`);
        if (settings.skippedCountries[countryCode]) {
            lastCountryCheckedPartnerId = currentPartnerId;
            lastCountryCheckedCode = countryCode;
            const msg = `[OmeTV] Blocked country matched (${countryName} / ${countryCode}) → SKIPPING`;
            console.log(msg);
            peaceLog(`🌍 Blocked country matched (${countryCode}) → SKIPPING`, 'warning');
            showToast(`🌍 Skipping ${countryName} (${countryCode})`, '#ffaa00');
            const ok = triggerAction(['next', 'start', 'skip']);
            console.log('[OmeTV] Skip click result:', ok);
            if (!ok) {
                // Fallback: Escape then retry once (some ome.tv builds need it)
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                setTimeout(() => {
                    const ok2 = triggerAction(['next', 'start', 'skip']);
                    console.log('[OmeTV] Skip retry result:', ok2);
                }, 300);
            }
        } else {
            // Remember we already logged/checked this partner so we don't spam.
            lastCountryCheckedPartnerId = currentPartnerId;
            lastCountryCheckedCode = countryCode;
            console.log(`[OmeTV] Country ${countryCode} not in blocklist → staying`);
        }
    }

    function setupCountryPoller() {
        // The .tr-country element updates independently of chat messages,
        // so poll it — the chat observer alone misses it.
        // 2.5s + single-element lookup = negligible cost (was 1s + full scans = hang).
        if (window._omeCountryPoller) return;
        window._omeCountryPoller = setInterval(() => {
            try { checkCountryFilter(); } catch (e) {}
        }, 2500);
    }

    let _lastChatCountryCheck = 0;
    function setupChatObserver() {
        const chatObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // If the country badge itself changed, check right away (cheap).
                        try {
                            if (node.classList && (node.classList.contains('tr-country') || (node.querySelector && node.querySelector('.tr-country')))) {
                                _lastChatCountryCheck = Date.now();
                                checkCountryFilter();
                                return;
                            }
                        } catch (e) {}
                        const bubbles = node.classList.contains('message-bubble') ? [node] : node.querySelectorAll('.message-bubble');
                        bubbles.forEach(bubble => {
                            const isUser = bubble.classList.contains('user') || bubble.classList.contains('self') || bubble.classList.contains('message-bubble--user') || bubble.closest('.user') || bubble.closest('.message-bubble--user');
                            const text = bubble.textContent.trim();

                            const isOurMessage = currentPartnerSentTexts.includes(text);
                            if (!isUser && !isOurMessage) {
                                if (text && !currentPartnerTexts.includes(text)) {
                                    currentPartnerTexts.push(text);
                                    if (capturedScreenshots.length > 0) {
                                        const latest = capturedScreenshots[capturedScreenshots.length - 1];
                                        if (!latest.partnerText) latest.partnerText = [];
                                        if (!latest.partnerText.includes(text)) {
                                            latest.partnerText.push(text);
                                            renderGalleryGrid();
                                        }
                                    }
                                }
                            }
                        });
                    }
                });
            });
            // Debounced: chat fires constantly — max 1 country check per 2s from here
            // (poller covers the rest). Calling it every mutation = hang.
            const now = Date.now();
            if (now - _lastChatCountryCheck > 2000) {
                _lastChatCountryCheck = now;
                try { checkCountryFilter(); } catch (e) {}
            }
        });

        const chatContainer = document.querySelector('.chat__messages, .chat, body');
        if (chatContainer) {
            chatObserver.observe(chatContainer, { childList: true, subtree: true });
        }
    }

    // ==========================================
    // 5. ACTION SYSTEM & LOGGING
    // ==========================================
    let hasSentHi = false;
    document.addEventListener('keydown', function(event) {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
        const key = event.key.toLowerCase();

        if (key === settings.pauseKey) {
            event.preventDefault();
            if (window.setMasterState) {
                window.setMasterState(!settings.masterEnable);
            }
            return;
        }

        if (!settings.masterEnable) return;

        if (key === settings.skipKey) {
            event.preventDefault();
            triggerServerRestart();
            triggerAction(['next', 'start', 'skip']);
        }
        else if (key === settings.stopKey) { event.preventDefault(); triggerAction(['stop', 'pause']); }
    });

    document.addEventListener('click', function(event) {
        if (!settings.masterEnable || !settings.restartVideoEnabled) return;
        const target = event.target.closest('button, div[role="button"], .btn, a.btn');
        if (target) {
            const text = (target.innerText || target.textContent || '').trim().toLowerCase();
            const cls = (target.className || '').toLowerCase();
            if (cls.includes('next') || cls.includes('skip') || text.includes('next') || text.includes('skip')) {
                triggerServerRestart();
            }
        }
    }, true);

    function triggerAction(keywords) {
        resetPartnerState();
        currentPartnerId++;
        // Next person takes a moment to load — ignore the stale country badge briefly
        // so we don't instantly skip the NEW person for the OLD person's country.
        window._omeSkipCooldownUntil = Date.now() + 2000;
        _lastTrText = '';
        _lastTrCache = null;

        totalGeneralSkips++;
        updateText('ome-total-skips', totalGeneralSkips);

        triggerServerRestart();

        const directSelectors = [
            '.btn-next', '.tv-button--next', '[data-action="next"]',
            '.btn-start', '[data-action="start"]', '.chat-control-next',
            'button.next', 'button.skip', '.buttons__next', '#next-btn',
            '#btn-next', '.btn__next', '.controls__next', '.next-btn',
            '[aria-label*="next" i]', '[aria-label*="skip" i]',
            '[data-tr="next"]', '[data-tr="skip"]', '.tr-next', '.tr-skip'
        ];

        for (const sel of directSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                el.click();
                peaceLog('ACTION: clicked ' + sel, 'action');
                return true;
            }
        }

        let buttons = document.querySelectorAll('button, div[role="button"], .btn, a.btn');
        for (let btn of buttons) {
            let text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            let title = (btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
            for (let keyword of keywords) {
                if ((text.includes(keyword) || title.includes(keyword)) && btn.offsetParent !== null) {
                    btn.click(); peaceLog('ACTION: clicked "' + keyword + '"', 'action'); return true;
                }
            }
        }
        if (keywords.includes('next')) {
            let skipBtn = document.querySelector('.btn-next, .tv-button--next, [data-action="next"], .btn-start, [data-action="start"]');
            if (skipBtn && skipBtn.offsetParent !== null) { skipBtn.click(); peaceLog('ACTION: fallback skip', 'action'); return true; }
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', keyCode: 68, code: 'KeyD', bubbles: true }));
        }
        return false;
    }

    function sendChatMessage(text) {
        const chatInput = document.querySelector('input#chat-text, .chat__textarea, input[data-tr="write-a-message"], input[placeholder*="message" i], textarea');
        if (!chatInput) {
            peaceLog('⚠️ Chat input not found — cannot send greeting', 'warning');
            return false;
        }

        if (!currentPartnerSentTexts.includes(text)) {
            currentPartnerSentTexts.push(text);
        }

        try { chatInput.focus(); } catch (e) {}

        let typed = false;
        try {
            chatInput.focus();
            if (typeof chatInput.setSelectionRange === 'function') {
                chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
            }
            typed = document.execCommand('insertText', false, text);
        } catch (e) { typed = false; }

        if (!typed || chatInput.value !== text) {
            try {
                const proto = chatInput.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(chatInput, text);
                else chatInput.value = text;
            } catch (e) { chatInput.value = text; }
        }

        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.dispatchEvent(new Event('change', { bubbles: true }));

        ['keydown', 'keypress', 'keyup'].forEach(type => {
            chatInput.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        });

        setTimeout(() => {
            try {
                if (chatInput.value && chatInput.value.length > 0) {
                    const sendBtn = document.querySelector('button[class*=send i], [class*=send-btn i], [aria-label*=send i]');
                    if (sendBtn && sendBtn.offsetParent !== null) {
                        sendBtn.click();
                        peaceLog('↩️ Enter ignored — clicked send button instead', 'action');
                    } else {
                        peaceLog('⚠️ Greeting may not have sent (message box still full)', 'warning');
                    }
                }
            } catch (e) {}
        }, 600);

        return true;
    }

    function peaceLog(message, type = 'default') {
        const log = document.getElementById('ome-peace-log');
        if (log) {
            const line = document.createElement('div');
            let color = '#ccc';
            if (type === 'success') color = '#55ff88'; else if (type === 'error') color = '#ff5555';
            else if (type === 'warning') color = '#ffaa00'; else if (type === 'action') color = '#00d0ff';
            else if (type === 'peace') color = '#88ffaa'; else if (type === 'male') color = '#55aaff';
            else if (type === 'frozen') color = '#aaddff'; else if (type === 'noface') color = '#ff8855';
            else if (type === 'black') color = '#999999';
            line.style.color = color;
            line.innerHTML = `<span style="color: #666;">[${new Date().toLocaleTimeString()}]</span>${message}`;
            log.appendChild(line);
            while (log.children.length > 30) log.removeChild(log.firstChild);
            log.scrollTop = log.scrollHeight;
        }
    }

    // ==========================================================
    // COUNTRY FLAG OVERLAY + SCREENSHOT GALLERY
    // ==========================================================
    function countryNameToCode(name) {
        if (!name) return '';
        const key = name.trim().toLowerCase();
        const map = {
            'albania': 'AL', 'greece': 'GR', 'ecuador': 'EC',
            'germany': 'DE', 'deutschland': 'DE', 'france': 'FR', 'italy': 'IT', 'italia': 'IT',
            'spain': 'ES', 'españa': 'ES', 'portugal': 'PT', 'netherlands': 'NL', 'belgium': 'BE',
            'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'great britain': 'GB',
            'ireland': 'IE', 'poland': 'PL', 'romania': 'RO', 'bulgaria': 'BG', 'serbia': 'RS',
            'croatia': 'HR', 'bosnia': 'BA', 'north macedonia': 'MK', 'macedonia': 'MK',
            'turkey': 'TR', 'türkiye': 'TR', 'russia': 'RU', 'ukraine': 'UA', 'usa': 'US',
            'united states': 'US', 'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'brasil': 'BR',
            'argentina': 'AR', 'colombia': 'CO', 'peru': 'PE', 'perú': 'PE', 'chile': 'CL',
            'venezuela': 'VE', 'uruguay': 'UY', 'paraguay': 'PY', 'bolivia': 'BO',
            'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI', 'switzerland': 'CH',
            'austria': 'AT', 'czech republic': 'CZ', 'czechia': 'CZ', 'slovakia': 'SK',
            'hungary': 'HU', 'slovenia': 'SI', 'moldova': 'MD', 'georgia': 'GE', 'armenia': 'AM',
            'azerbaijan': 'AZ', 'kazakhstan': 'KZ', 'belarus': 'BY', 'lithuania': 'LT',
            'latvia': 'LV', 'estonia': 'EE', 'egypt': 'EG', 'morocco': 'MA', 'algeria': 'DZ',
            'tunisia': 'TN', 'nigeria': 'NG', 'south africa': 'ZA', 'india': 'IN', 'pakistan': 'PK',
            'china': 'CN', 'japan': 'JP', 'south korea': 'KR', 'korea': 'KR', 'philippines': 'PH',
            'indonesia': 'ID', 'vietnam': 'VN', 'thailand': 'TH', 'malaysia': 'MY', 'australia': 'AU',
            'new zealand': 'NZ', 'israel': 'IL', 'saudi arabia': 'SA', 'uae': 'AE',
            'united arab emirates': 'AE', 'iran': 'IR', 'iraq': 'IQ', 'cyprus': 'CY'
        };
        if (map[key]) return map[key];
        if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase();
        return '';
    }

    function cleanCountryText(raw) {
        if (!raw) return '';
        let t = String(raw).replace(/\s+/g, ' ').trim();
        const low = t.toLowerCase();
        const cutMarkers = ['connection established', 'connected', 'connecting', 'you are now', 'stranger', 'chatting with'];
        for (const m of cutMarkers) {
            const idx = low.indexOf(m);
            if (idx > 0) { t = t.slice(0, idx).trim(); break; }
        }
        t = t.split(/[•·|｜]/)[0].trim();
        const dashIdx = t.search(/\s[-–—]\s/);
        if (dashIdx > 0) t = t.slice(0, dashIdx).trim();
        t = t.replace(/^[^A-Za-z\u00C0-\u024F]+|[^A-Za-z\u00C0-\u024F]+$/g, '').trim();
        const parts = t.split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
            t = parts[0];
        }
        return t;
    }

    function getPartnerCountryInfo() {
        // 1. Fast path: the real badge <span class="tr-country" data-tr="GR">Greece</span>
        try {
            const direct = getDirectCountry();
            if (direct && (direct.countryCode || direct.countryName)) return direct;
        } catch (e) {}
        // 2. Legacy: scan inside chat bubbles (last 3 only — full scan hangs the page)
        const allBubbles = document.querySelectorAll('.message-bubble');
        const start = Math.max(0, allBubbles.length - 3);
        for (let i = allBubbles.length - 1; i >= start; i--) {
            const bubble = allBubbles[i];

            // Look for flag icons and explicit elements containing country data
            const flagEl = bubble.querySelector('.message-flag, [class*="flags-"], [class*="flag-"], img[src*="flag" i]');
            const countryEl = bubble.querySelector('.tr-country, [data-tr-country], [data-country-code], [data-code], [data-country]');

            if (!flagEl && !countryEl) continue;

            let countryCode = '';
            let countryName = '';

            // Enhanced regex extraction from data-tr attributes like data-tr="GR" or text content like "Greece"
            if (countryEl) {
                countryName = cleanCountryText(countryEl.textContent);
                const attr = (countryEl.getAttribute('data-tr') ||
                              countryEl.getAttribute('data-tr-country') ||
                              countryEl.getAttribute('data-country-code') ||
                              countryEl.getAttribute('data-code') ||
                              countryEl.getAttribute('data-country') || '').trim();
                if (/^[A-Za-z]{2}$/.test(attr)) {
                    countryCode = attr.toUpperCase();
                }
            }

            if (!countryCode && flagEl) {
                const clsRaw = typeof flagEl.className === 'string' ? flagEl.className : (flagEl.className && flagEl.className.baseVal) || '';
                const m = String(clsRaw).match(/flags?-([a-z]{2})\b/i);
                if (m) countryCode = m[1].toUpperCase();
                if (!countryCode && flagEl.tagName === 'IMG') {
                    const src = flagEl.getAttribute('src') || '';
                    const sm = src.match(/\/([a-z]{2})(?:\.[a-z]+)?$/i) || src.match(/[\/_-]([a-z]{2})\.(png|svg|jpg|webp)/i);
                    if (sm) countryCode = sm[1].toUpperCase();
                }
                if (!countryCode) {
                    const alt = (flagEl.getAttribute('title') || flagEl.getAttribute('alt') || '').trim();
                    if (alt) {
                        if (/^[A-Za-z]{2}$/.test(alt)) countryCode = alt.toUpperCase();
                        else if (!countryName) countryName = alt;
                    }
                }
            }

            if (!countryCode && countryName) {
                const cleaned = countryName.trim();
                if (/^[A-Za-z]{2}$/.test(cleaned)) {
                    countryCode = cleaned.toUpperCase();
                } else {
                    const lead = cleaned.match(/^([A-Za-z]{2})\s+[A-Za-z\u00C0-\u024F].*$/);
                    if (lead) {
                        countryCode = lead[1].toUpperCase();
                        countryName = cleaned.slice(3).trim() || countryCode;
                    } else {
                        countryCode = countryNameToCode(cleaned);
                    }
                }
            }

            // Fallback: search regex directly inside the flag element classes (e.g. flags-GR)
            if (!countryCode && flagEl) {
                const classStr = typeof flagEl.className === 'string' ? flagEl.className : '';
                const matchClass = classStr.match(/flags-([A-Za-z]{2})/i);
                if (matchClass) {
                    countryCode = matchClass[1].toUpperCase();
                }
            }

            if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) countryCode = '';

            if (countryCode || countryName) {
                if (!countryName) countryName = countryCode;
                return { countryCode, countryName };
            }
        }

        return { countryCode: '', countryName: '' };
    }

    function getFlagImageUrl(code, width = 80) {
        if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
        const w = (width === 20 || width === 40 || width === 80 || width === 160) ? width : 80;
        return `https://flagcdn.com/w${w}/${code.toLowerCase()}.png`;
    }

    function loadFlagImage(code) {
        return new Promise(resolve => {
            const url = getFlagImageUrl(code, 80);
            if (!url) return resolve(null);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => resolve(null), 2500);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = url;
        });
    }

    async function drawCountryOverlay(canvas) {
        const { countryCode, countryName } = getPartnerCountryInfo();
        if (!countryName && !countryCode) return { countryCode: '', countryName: '' };

        const ctx = canvas.getContext('2d');
        if (!ctx) return { countryCode, countryName };

        const textLabel = (countryCode || cleanCountryText(countryName) || '').toUpperCase();
        if (!textLabel) return { countryCode, countryName };
        const fullLabel = textLabel;

        ctx.save();
        ctx.font = 'bold 22px Arial, sans-serif';
        const textWidth = ctx.measureText(fullLabel).width;
        const padding = 12;
        const flagBox = countryCode ? 40 : 0;
        const rectWidth = textWidth + padding * 2 + flagBox;
        const rectHeight = 38;
        const x = 15;
        const y = 15;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, rectWidth, rectHeight, 8);
            ctx.fill();
        } else {
            ctx.fillRect(x, y, rectWidth, rectHeight);
        }

        let textX = x + padding;
        if (countryCode) {
            try {
                const flagImg = await loadFlagImage(countryCode);
                if (flagImg) {
                    const flagW = 30;
                    const flagH = 20;
                    const flagY = y + (rectHeight - flagH) / 2;
                    ctx.drawImage(flagImg, textX, flagY, flagW, flagH);
                    textX += flagW + 8;
                }
            } catch (e) {}
        }

        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(fullLabel, textX, y + rectHeight / 2);
        ctx.restore();

        return { countryCode, countryName };
    }

    async function captureRemoteScreenshot(sourceCanvas) {
        try {
            if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) return;

            const info = await drawCountryOverlay(sourceCanvas) || {};
            const countryCode = info.countryCode || '';
            const countryName = info.countryName || '';

            const dataUrl = sourceCanvas.toDataURL('image/jpeg', 0.85);
            const timestamp = new Date().toLocaleTimeString();

            capturedScreenshots.push({
                id: Date.now(),
                dataUrl: dataUrl,
                timestamp: timestamp,
                countryCode: countryCode,
                countryName: countryName,
                flagUrl: getFlagImageUrl(countryCode, 40),
                partnerText: [...currentPartnerTexts]
            });

            updateGalleryUI();
            renderGalleryGrid();
            peaceLog(`📸 Face snap saved (#${capturedScreenshots.length})${countryCode ? ` [${countryCode}]` : ''}`, 'success');
        } catch (err) {
            console.warn('Screenshot capture failed:', err);
        }
    }

    function createGalleryModal() {
        if (document.getElementById('ome-gallery-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'ome-gallery-modal';
        modal.innerHTML = `
            <h3 style="margin-top: 0; border-bottom: 1px solid #444; padding-bottom: 10px; color: #ff5e00;">
                📸 Captured Faces Gallery (<span id="ome-gallery-modal-count">0</span>)
            </h3>
            <div id="ome-gallery-grid"></div>
            <div class="ome-modal-buttons" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px; border-top: 1px solid #444; padding-top: 15px;">
                <button id="ome-gallery-download-all" style="background: #28a745; color: white;">Download All</button>
                <button id="ome-gallery-clear" style="background: #ffc107; color: black;">Clear All</button>
                <button id="ome-gallery-close" style="background: #dc3545; color: white;">Close</button>
            </div>
        `;
        document.body.appendChild(modal);

        const viewerModal = document.createElement('div');
        viewerModal.id = 'ome-image-viewer-modal';
        viewerModal.innerHTML = `
            <img id="ome-viewer-img" alt="Full size preview">
            <div id="ome-viewer-caption"></div>
        `;
        document.body.appendChild(viewerModal);

        viewerModal.addEventListener('click', () => {
            viewerModal.style.display = 'none';
        });

        modal.querySelector('#ome-gallery-close').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        modal.querySelector('#ome-gallery-clear').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all saved gallery screenshots?')) {
                capturedScreenshots = [];
                renderGalleryGrid();
                updateGalleryUI();
            }
        });

        modal.querySelector('#ome-gallery-download-all').addEventListener('click', async (e) => {
            if (!capturedScreenshots.length) {
                alert('No screenshots to download.');
                return;
            }

            const btn = e.target;
            const originalText = btn.textContent;
            btn.textContent = 'Zipping...';
            btn.disabled = true;

            try {
                const zip = new JSZip();
                capturedScreenshots.forEach((item, index) => {
                    const base64Data = item.dataUrl.split(',')[1];
                    const prefix = item.countryCode ? `${item.countryCode}_` : '';
                    zip.file(`face_capture_${prefix}${index + 1}_${item.id}.jpg`, base64Data, { base64: true });
                });

                const zipContent = await zip.generateAsync({ type: "blob" });
                const zipUrl = URL.createObjectURL(zipContent);

                const a = document.createElement('a');
                a.href = zipUrl;
                a.download = `ometv_faces_${Date.now()}.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(zipUrl);

                btn.textContent = 'Full / Done!';
                setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
            } catch (err) {
                btn.textContent = 'Error!';
                setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
            }
        });
    }

    function openGalleryModal() {
        createGalleryModal();
        renderGalleryGrid();
        const modal = document.getElementById('ome-gallery-modal');
        if (modal) modal.style.display = 'block';
    }

    function renderGalleryGrid() {
        const grid = document.getElementById('ome-gallery-grid');
        if (!grid) return;

        grid.innerHTML = '';
        if (capturedScreenshots.length === 0) {
            grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #888; padding: 20px;">No face screenshots captured yet.</div>';
            return;
        }

        const sortedScreenshots = [...capturedScreenshots].sort((a, b) => {
            const aHasText = a.partnerText && a.partnerText.length > 0;
            const bHasText = b.partnerText && b.partnerText.length > 0;
            return (bHasText ? 1 : 0) - (aHasText ? 1 : 0);
        });

        sortedScreenshots.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'ome-gallery-card';

            const hasText = item.partnerText && item.partnerText.length > 0;
            if (hasText) {
                card.style.border = '2px solid #ff4444';
                card.style.padding = '8px';
                card.style.backgroundColor = '#2a1a1a';
            }

            const code = (item.countryCode || '').toUpperCase();
            const flagImg = item.flagUrl || (code ? getFlagImageUrl(code, 40) : '');
            const badge = code ? `<div class="ome-gallery-flag">${flagImg ? `<img src="${flagImg}" alt="${code} flag">` : ''}<span>${code}</span></div>` : ``;

            const textBtnHtml = hasText ? `<button class="ome-view-text-btn" style="width: 100%; font-size: 11px; padding: 3px; background: #dc3545; color: white; border: none; border-radius: 3px; cursor: pointer; margin-top: 4px;">💬 View Text (${item.partnerText.length})</button>` : '';

            card.innerHTML = `
                <img src="${item.dataUrl}" alt="Captured face ${index + 1}" class="ome-gallery-thumb">
                <span>#${index + 1} - ${item.timestamp}</span>
                ${badge}
                ${textBtnHtml}
                <button class="ome-dl-item-btn" style="margin-top: 4px;">Download</button>
            `;

            card.querySelector('.ome-gallery-thumb').addEventListener('click', () => {
                const viewer = document.getElementById('ome-image-viewer-modal');
                const vImg = document.getElementById('ome-viewer-img');
                const vCap = document.getElementById('ome-viewer-caption');
                if (viewer && vImg) {
                    vImg.src = item.dataUrl;
                    if (vCap) vCap.textContent = `#${index + 1} - ${item.timestamp} ${code ? `(${code})` : ''}`;
                    viewer.style.display = 'flex';
                }
            });

            if (hasText) {
                card.querySelector('.ome-view-text-btn').addEventListener('click', () => {
                    alert(`Partner Messages (${item.countryCode || 'Unknown'}):\n\n` + item.partnerText.join('\n'));
                });
            }

            card.querySelector('.ome-dl-item-btn').addEventListener('click', () => {
                const prefix = code ? `${code}_` : '';
                downloadImage(item.dataUrl, `face_capture_${prefix}${index + 1}_${item.id}.jpg`);
            });
            grid.appendChild(card);
        });
    }

    function updateGalleryUI() {
        updateText('ome-gallery-count', capturedScreenshots.length);
        const modalCount = document.getElementById('ome-gallery-modal-count');
        if (modalCount) modalCount.textContent = capturedScreenshots.length;
    }

    function downloadImage(dataUrl, filename) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ==========================================
    // 6. DETECTORS (Peace, Face, Gender, Frozen)
    // ==========================================
    let handsDetector = null, detectorStarted = false, peaceFrames = 0, lastPeaceSkip = 0, totalPeaceSkips = 0, lastDetectionTime = 0;

    function createPeacePanel() {
        if (document.getElementById('ome-peace-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'ome-peace-panel';
        panel.style.display = settings.showPeacePanel ? 'block' : 'none';
        panel.innerHTML = `
            <div class="peace-title">✌️ Auto-Skip Panel</div>
            <div id="ome-peace-status" class="searching">🔍 Initializing...</div>
            <div class="ome-peace-row"><span>Master:</span><span id="ome-master-status" style="font-weight:bold; color: ${settings.masterEnable ? '#55ff88' : '#ff5555'}">${settings.masterEnable ? 'ACTIVE' : 'PAUSED'}</span></div>
            <div class="ome-peace-row"><span>Camera:</span><span id="ome-peace-camera">--</span></div>
            <div class="ome-peace-row"><span>Hand:</span><span id="ome-peace-hand">--</span></div>
            <div class="ome-peace-row"><span>Peace frames:</span><span id="ome-peace-frames">0</span></div>
            <div class="ome-peace-row"><span>Total skips:</span><span id="ome-total-skips">0</span></div>
            <div class="ome-peace-row"><span>Peace auto-skips:</span><span id="ome-peace-skips">0</span></div>
            <div class="ome-peace-row"><span>Peace auto:</span><span id="ome-peace-enabled">${settings.peaceAutoSkip ? 'ON' : 'OFF'}</span></div>
            <div id="ome-peace-log"></div>
            <div class="ome-peace-controls">
                <button id="ome-master-toggle" style="flex: 1 1 100%; margin-bottom: 5px; font-weight: bold; background: ${settings.masterEnable ? '#e65100' : '#dc3545'};">${settings.masterEnable ? 'Pause All' : 'Resume All'}</button>
                <button id="ome-gallery-btn" style="flex: 1 1 100%; margin-bottom: 5px; background: #6c757d; font-weight: bold;">📸 Gallery (<span id="ome-gallery-count">0</span>)</button>
                <button id="ome-peace-toggle">${settings.peaceAutoSkip ? 'Disable Peace' : 'Enable Peace'}</button>
                <button id="ome-peace-clear">Clear Logs</button>
            </div>
        `;
        document.body.appendChild(panel);

        const titleBar = panel.querySelector('.peace-title');
        let isDraggingPanel = false, startXP, startYP, initialLeftP, initialTopP;
        titleBar.addEventListener('mousedown', e => {
            isDraggingPanel = true; startXP = e.clientX; startYP = e.clientY;
            const rect = panel.getBoundingClientRect(); initialLeftP = rect.left; initialTopP = rect.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = initialLeftP + 'px'; panel.style.top = initialTopP + 'px';
            document.addEventListener('mousemove', onPanelMove); document.addEventListener('mouseup', onPanelUp);
        });
        function onPanelMove(e) { if (!isDraggingPanel) return; panel.style.left = (initialLeftP + (e.clientX - startXP)) + 'px'; panel.style.top = (initialTopP + (e.clientY - startYP)) + 'px'; }
        function onPanelUp() { isDraggingPanel = false; document.removeEventListener('mousemove', onPanelMove); document.removeEventListener('mouseup', onPanelUp); }

        window.setMasterState = function(state) {
            settings.masterEnable = state; localStorage.setItem('ometv_custom_settings', JSON.stringify(settings));

            resetPartnerState();
            peaceFrames = 0;

            const mToggle = document.getElementById('ome-master-toggle'); const mStatus = document.getElementById('ome-master-status');
            if (mToggle && mStatus) {
                if (settings.masterEnable) { mToggle.textContent = 'Pause All'; mToggle.style.background = '#e65100'; mStatus.textContent = 'ACTIVE'; mStatus.style.color = '#55ff88'; peaceLog('▶️ All automations RESUMED', 'success'); showToast('▶️ Script RESUMED', '#55ff88'); }
                else { mToggle.textContent = 'Resume All'; mToggle.style.background = '#dc3545'; mStatus.textContent = 'PAUSED'; mStatus.style.color = '#ff5555'; peaceLog('⏸️ All automations PAUSED', 'error'); showToast('⏸️ Script PAUSED', '#ff5555'); }
            }
        };

        panel.querySelector('#ome-master-toggle').addEventListener('click', () => window.setMasterState(!settings.masterEnable));

        panel.querySelector('#ome-gallery-btn').addEventListener('click', () => {
            openGalleryModal();
        });
        const toggle = panel.querySelector('#ome-peace-toggle'); toggle.classList.toggle('active', settings.peaceAutoSkip);
        toggle.addEventListener('click', () => {
            settings.peaceAutoSkip = !settings.peaceAutoSkip; localStorage.setItem('ometv_custom_settings', JSON.stringify(settings));
            toggle.textContent = settings.peaceAutoSkip ? 'Disable Peace' : 'Enable Peace'; toggle.classList.toggle('active', settings.peaceAutoSkip);
            document.getElementById('ome-peace-enabled').textContent = settings.peaceAutoSkip ? 'ON' : 'OFF';
            peaceLog(settings.peaceAutoSkip ? 'Peace Auto-skip ENABLED' : 'Peace Auto-skip DISABLED', settings.peaceAutoSkip ? 'success' : 'warning');
        });
        panel.querySelector('#ome-peace-clear').addEventListener('click', () => document.getElementById('ome-peace-log').innerHTML = '');
    }

    function findLocalCamera() {
        const videos = [...document.querySelectorAll('video')];
        return videos.find(v => v.muted || v.hasAttribute('muted') || (v.parentElement?.id || '').includes('local') || (v.parentElement?.className || '').includes('local')) || null;
    }

    async function initializePeaceDetector() {
        if (detectorStarted) return;
        detectorStarted = true; createPeacePanel(); peaceLog('Initializing hand detector...', 'default');
        if (typeof Hands === 'undefined') { setPeaceStatus('❌ MediaPipe Hands unavailable', false); return; }
        handsDetector = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}` });
        handsDetector.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.60, minTrackingConfidence: 0.60 });
        handsDetector.onResults(processHandResults); peaceLog('Hand detector initialized', 'success');
        detectionLoop();
    }

    function setPeaceStatus(text, detected) {
        const status = document.getElementById('ome-peace-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('detected', detected);
        status.classList.toggle('searching', !detected);
    }

    function processHandResults(results) {
        if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
            updateText('ome-peace-hand', 'NO');
            setPeaceStatus('🔍 No hand detected', false);
            peaceFrames = 0;
            updateText('ome-peace-frames', '0');
            return;
        }
        updateText('ome-peace-hand', 'YES');
        let peace = results.multiHandLandmarks.some(isPeaceSign);
        if (peace) {
            peaceFrames++;
            updateText('ome-peace-frames', peaceFrames);
            setPeaceStatus('✌️ PEACE SIGN DETECTED', true);
            if (peaceFrames >= settings.peaceRequiredFrames) attemptPeaceSkip();
        } else {
            peaceFrames = 0;
            updateText('ome-peace-frames', '0');
            setPeaceStatus('🖐 Hand detected — not peace sign', false);
        }
    }

    function distance(a, b) { return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2); }
    function fingerExtended(l, tip, pip, mcp) { const w = l[0]; return (distance(l[tip], w) > distance(l[pip], w) * 1.12 && distance(l[pip], w) > distance(l[mcp], w) * 0.95); }
    function fingerFolded(l, tip, pip, mcp) { const w = l[0]; return (distance(l[tip], w) < distance(l[pip], w) * 1.08 || distance(l[tip], w) < distance(l[mcp], w) * 1.35); }
    function isPeaceSign(l) { return fingerExtended(l, 8, 6, 5) && fingerExtended(l, 12, 10, 9) && fingerFolded(l, 16, 14, 13) && fingerFolded(l, 20, 18, 17) && (distance(l[8], l[12]) > distance(l[0], l[9]) * 0.28); }

    function attemptPeaceSkip() {
        const now = Date.now();
        if (!settings.peaceAutoSkip || now - lastPeaceSkip < settings.peaceCooldown) return;
        lastPeaceSkip = now; peaceFrames = 0;
        updateText('ome-peace-frames', '0');
        totalPeaceSkips++;
        updateText('ome-peace-skips', totalPeaceSkips);
        setPeaceStatus('🚀 PEACE → SKIPPING!', true);
        peaceLog('✌️ PEACE SIGN → AUTO SKIP', 'peace');
        setTimeout(() => triggerAction(['next', 'start', 'skip']), 100);
    }

    async function detectionLoop() {
        while (true) {
            try {
                if (!settings.masterEnable) {
                    setPeaceStatus('⏸️ Master Script Paused', false);
                    await sleep(1000);
                    continue;
                }
                currentCamera = findLocalCamera();
                if (!currentCamera) {
                    updateText('ome-peace-camera', 'NO');
                    setPeaceStatus('🔍 Waiting for local camera...', false);
                    await sleep(1000);
                    continue;
                }
                updateText('ome-peace-camera', 'YES');
                if (currentCamera.readyState >= 2 && currentCamera.videoWidth > 0 && currentCamera.videoHeight > 0) {
                    if (Date.now() - lastDetectionTime >= settings.detectionInterval) {
                        lastDetectionTime = Date.now(); await handsDetector.send({ image: currentCamera });
                    }
                }
            } catch (error) {
                await sleep(500);
            }
            await sleep(Math.max(30, settings.detectionInterval));
        }
    }

    let remoteMaleFrames = 0, noFaceStartTime = 0, isGenderModelLoaded = false, lastMaleSkip = 0, lastNoFaceSkip = 0, remoteCanvas = null;
    function findRemoteVideo() {
        return [...document.querySelectorAll('video')].find(v => {
            const isLocal = v.muted || v.hasAttribute('muted') || (v.parentElement?.id || '').includes('local') || (v.parentElement?.className || '').includes('local');
            return !isLocal && v.readyState >= 2 && !v.paused;
        }) || null;
    }

    let lastActiveRemoteSrc = null;
    let remoteDisconnectTimeout = null;
    function setupRemoteDisconnectListener() {
        setInterval(() => {
            if (!settings.masterEnable) return;
            const remoteVideo = findRemoteVideo();
            const currentSrc = remoteVideo ? (remoteVideo.srcObject || remoteVideo.currentSrc || remoteVideo.src) : null;

            if (lastActiveRemoteSrc && (!remoteVideo || remoteVideo.paused || remoteVideo.ended)) {
                if (!remoteDisconnectTimeout) {
                    remoteDisconnectTimeout = setTimeout(() => {
                        peaceLog('🔄 Remote user skipped/disconnected', 'action');
                        triggerServerRestart();
                        lastActiveRemoteSrc = null;
                        remoteDisconnectTimeout = null;
                    }, 400);
                }
            } else if (currentSrc) {
                if (remoteDisconnectTimeout) {
                    clearTimeout(remoteDisconnectTimeout);
                    remoteDisconnectTimeout = null;
                }
                lastActiveRemoteSrc = currentSrc;
            }
        }, 300);
    }

    async function loadGenderModels() {
        if (isGenderModelLoaded) return true;
        const MODEL_HOSTS = [
            'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/',
            'https://justadudewhohacks.github.io/face-api.js/models/',
            'https://raw.githubusercontent.com/vladmandic/face-api/master/model/'
        ];

        for (const host of MODEL_HOSTS) {
            try {
                await faceapi.nets.tinyFaceDetector.loadFromUri(host);
                await faceapi.nets.faceLandmark68TinyNet.loadFromUri(host);
                await faceapi.nets.ageGenderNet.loadFromUri(host);
                isGenderModelLoaded = true;
                return true;
            } catch (err) {}
        }
        return false;
    }

    function setupCanvasOverlay(video) {
        const container = video.parentElement;
        if (!remoteCanvas) { remoteCanvas = document.createElement('canvas'); remoteCanvas.style.position = 'absolute'; remoteCanvas.style.top = '0'; remoteCanvas.style.left = '0'; remoteCanvas.style.width = '100%'; remoteCanvas.style.height = '100%'; remoteCanvas.style.pointerEvents = 'none'; remoteCanvas.style.zIndex = '999995'; container.appendChild(remoteCanvas); }
        else if (remoteCanvas.parentElement !== container) container.appendChild(remoteCanvas);
        return remoteCanvas;
    }

    async function remoteGenderLoop() {
        await loadGenderModels();
        let lastVideoRef = null;
        let lastVideoSrc = null;

        while (true) {
            try {
                if (!settings.masterEnable) {
                    if (remoteCanvas) remoteCanvas.getContext('2d').clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
                    noFaceStartTime = 0;
                    remoteMaleFrames = 0;
                    await sleep(1000); continue;
                }
                const remoteVideo = findRemoteVideo();
                if (remoteVideo && remoteVideo.readyState >= 2 && remoteVideo.videoWidth > 0 && remoteVideo.videoHeight > 0 && !remoteVideo.paused) {
                    const currentSrc = remoteVideo.srcObject || remoteVideo.currentSrc || remoteVideo.src;
                    if (remoteVideo !== lastVideoRef || currentSrc !== lastVideoSrc) {
                        lastVideoRef = remoteVideo;
                        lastVideoSrc = currentSrc;
                        currentPartnerId++;
                        resetPartnerState();
                        checkCountryFilter();
                    }

                    const encounterId = currentPartnerId;

                    if (settings.skipMaleAuto || settings.skipNoFaceAuto || settings.saveMode) {
                        const canvas = setupCanvasOverlay(remoteVideo); const displaySize = { width: remoteVideo.videoWidth, height: remoteVideo.videoHeight };
                        faceapi.matchDimensions(canvas, displaySize);

                        const snapCanvas = document.createElement('canvas');
                        snapCanvas.width = remoteVideo.videoWidth;
                        snapCanvas.height = remoteVideo.videoHeight;
                        const snapCtx = snapCanvas.getContext('2d');
                        if (snapCtx) snapCtx.drawImage(remoteVideo, 0, 0, snapCanvas.width, snapCanvas.height);

                        const detections = await Promise.race([
                            faceapi.detectAllFaces(snapCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.25 }))
                                .withFaceLandmarks(true)
                                .withAgeAndGender(),
                            new Promise(resolve => setTimeout(() => resolve(null), 5000))
                        ]);

                        const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);

                        if (detections && detections.length > 0) {
                            noFaceStartTime = 0;
                            if (settings.saveMode && !capturedPartnerIds.has(encounterId)) {
                                capturedPartnerIds.add(encounterId);
                                setTimeout(() => { captureRemoteScreenshot(snapCanvas); }, 0);
                            }

                            if (encounterId === currentPartnerId && settings.skipMaleAuto) {
                                const resized = faceapi.resizeResults(detections, displaySize);
                                resized.forEach(r => new faceapi.draw.DrawBox(r.detection.box, { label: `${r.gender} (${(r.genderProbability * 100).toFixed(0)}%)`, lineWidth: 3, boxColor: r.gender === 'male' ? 'rgba(0,150,255,0.9)' : 'rgba(255,100,150,0.9)' }).draw(canvas));
                                const primary = detections[0];
                                if (primary.gender === 'male' && primary.genderProbability >= settings.maleConfidenceThreshold) {
                                    remoteMaleFrames++; if (remoteMaleFrames >= settings.maleRequiredFrames) attemptSkip('♂️ Male detected', 'male', lastMaleSkip, settings.maleCooldown, () => lastMaleSkip = Date.now());
                                } else if (primary.gender === 'female' && primary.genderProbability >= 0.65) {
                                    remoteMaleFrames = 0;
                                    if (!hasSentHi) {
                                        sendChatMessage(settings.femaleGreetingMessage); hasSentHi = true;
                                        peaceLog(`👩 Female detected → Sent "${settings.femaleGreetingMessage}"`, 'success');
                                        if (settings.pauseOnFemale) { waitingForRemoteSkip = true; window.setMasterState(false); }
                                    }
                                } else remoteMaleFrames = 0;
                            }
                        } else if (detections) {
                            remoteMaleFrames = 0;
                            if (settings.skipNoFaceAuto) {
                                if (noFaceStartTime === 0) noFaceStartTime = Date.now();
                                const elapsed = Date.now() - noFaceStartTime;
                                ctx.fillStyle = 'rgba(255, 50, 50, 0.85)'; ctx.font = 'bold 22px Arial'; ctx.fillText(`⚠️ NO FACE (${(elapsed / 1000).toFixed(1)}s)`, 15, 35);
                                if (elapsed >= settings.noFaceRequiredSeconds * 1000) { attemptSkip('⚠️ No face detected', 'noface', lastNoFaceSkip, settings.noFaceCooldown, () => { lastNoFaceSkip = Date.now(); noFaceStartTime = 0; }); }
                            }
                        }
                    }
                } else {
                    if (remoteCanvas) remoteCanvas.getContext('2d').clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
                    remoteMaleFrames = 0; noFaceStartTime = 0; lastVideoRef = null; lastVideoSrc = null;
                }
            } catch (error) {}
            await sleep(400);
        }
    }

    let lastFrozenSkip = 0, frozenStartTime = 0, lastFrameData = null;
    let lastBlackSkip = 0, blackStartTime = 0;
    async function remoteFreezeLoop() {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const ctx = canvas.getContext('2d', { willReadFrequently: true });
        while (true) {
            try {
                if (!settings.masterEnable) {
                    frozenStartTime = 0; lastFrameData = null; blackStartTime = 0;
                    await sleep(1000); continue;
                }
                if (settings.skipFrozenAuto || settings.skipBlackAuto) {
                    const remoteVideo = findRemoteVideo();
                    if (remoteVideo && remoteVideo.readyState >= 2 && remoteVideo.videoWidth > 0 && remoteVideo.videoHeight > 0 && !remoteVideo.paused) {
                        ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height); const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

                        if (settings.skipBlackAuto) {
                            let lumSum = 0;
                            for (let i = 0; i < currentFrame.length; i += 4) { lumSum += currentFrame[i] + currentFrame[i + 1] + currentFrame[i + 2]; }
                            const avgLum = lumSum / (currentFrame.length / 4 * 3);
                            if (avgLum < (settings.blackLuminanceThreshold || 12)) {
                                if (blackStartTime === 0) blackStartTime = Date.now();
                                if (Date.now() - blackStartTime >= ((settings.blackRequiredSeconds || 2.5) * 1000)) { attemptBlackSkip(avgLum); blackStartTime = 0; }
                            } else blackStartTime = 0;
                        } else blackStartTime = 0;

                        if (settings.skipFrozenAuto) {
                            if (lastFrameData) {
                                let diff = 0;
                                for (let i = 0; i < currentFrame.length; i += 4) { diff += Math.abs(currentFrame[i] - lastFrameData[i]) + Math.abs(currentFrame[i+1] - lastFrameData[i+1]) + Math.abs(currentFrame[i+2] - lastFrameData[i+2]); }
                                if (diff / 1024 < 0.8) {
                                    if (frozenStartTime === 0) frozenStartTime = Date.now();
                                    if (Date.now() - frozenStartTime >= settings.frozenRequiredSeconds * 1000) { attemptFrozenSkip(); frozenStartTime = 0; }
                                } else frozenStartTime = 0;
                            }
                        }
                        lastFrameData = new Uint8ClampedArray(currentFrame);
                    } else { frozenStartTime = 0; lastFrameData = null; blackStartTime = 0; }
                }
            } catch (err) {}
            await sleep(500);
        }
    }

    function attemptFrozenSkip() {
        const now = Date.now();
        if (now - lastFrozenSkip < settings.frozenCooldown) return;
        lastFrozenSkip = now;
        peaceLog('❄️ Frozen camera detected → SKIPPING', 'frozen');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        setTimeout(() => triggerAction(['next', 'start', 'skip']), 100);
    }

    function attemptBlackSkip(avgLum) {
        const now = Date.now();
        if (now - lastBlackSkip < (settings.blackCooldown || 3000)) return;
        lastBlackSkip = now;
        peaceLog(`⬛ Black screen detected (brightness ${(avgLum || 0).toFixed(1)}) → SKIPPING`, 'black');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        setTimeout(() => triggerAction(['next', 'start', 'skip']), 100);
    }

    function attemptSkip(logMsg, logType, lastTime, cooldown, updateTime) {
        if (Date.now() - lastTime < cooldown) return;
        updateTime(); peaceLog(logMsg + ' → SKIPPING', logType);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        setTimeout(() => triggerAction(['next', 'start', 'skip']), 100);
    }

    // ==========================================
    // INITIALIZATION
    // ==========================================
    function initialize() {
        applySettings(); createSettingsUI(); createPeacePanel(); createGalleryModal(); setupVideoTools(); setupChatObserver();
        setupCountryPoller();
        setupRemoteDisconnectListener();
        setTimeout(initializePeaceDetector, 1500);
        setTimeout(remoteGenderLoop, 2500);
        setTimeout(remoteFreezeLoop, 3000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize); else initialize();

})();