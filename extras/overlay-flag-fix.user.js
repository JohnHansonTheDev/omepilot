// ==UserScript==
// @name         Ome.tv Country Filter Overlay Fix
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Centers the Ome.tv country filter, makes it fit the screen, and adds a scrollbar.
// @author       You
// @match        *://ome.tv/*
// @match        *://*.ome.tv/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // 1. Inject CSS to override Ome.tv's positioning and force a scrollable, centered box
    const style = document.createElement('style');
    style.innerHTML = `
        /* We use body > to ensure these only apply after we move it */
        body > .country-filter-popup {
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            max-height: 85vh !important;  /* Prevents it from being taller than the screen */
            width: auto !important;
            max-width: 90vw !important;   /* Prevents it from being wider than the screen */
            overflow-y: auto !important;  /* Adds the vertical scrollbar */
            overflow-x: hidden !important;
            z-index: 9999999 !important;
            box-shadow: 0 10px 50px rgba(0,0,0,0.6) !important;
            border-radius: 8px !important;
        }

        /* Make the scrollbar look nice */
        body > .country-filter-popup::-webkit-scrollbar {
            width: 8px;
        }
        body > .country-filter-popup::-webkit-scrollbar-thumb {
            background-color: #888;
            border-radius: 4px;
        }
        body > .country-filter-popup::-webkit-scrollbar-track {
            background-color: transparent;
        }
    `;
    document.head.appendChild(style);

    // 2. Function to move the popup directly to the body element
    function promotePopup(popup) {
        if (popup.parentElement !== document.body) {
            document.body.appendChild(popup);
        }
    }

    // 3. Monitor the DOM for when the popup is opened
    const observer = new MutationObserver(() => {
        const popup = document.querySelector('.country-filter-popup');
        if (popup) {
            promotePopup(popup);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Initial check in case it's already there
    const existingPopup = document.querySelector('.country-filter-popup');
    if (existingPopup) {
        promotePopup(existingPopup);
    }
})();