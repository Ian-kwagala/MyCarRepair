(function () {
    if (window.__myCarRepairAlertsBooted) {
        return;
    }
    window.__myCarRepairAlertsBooted = true;

    const AppAlert = {
        show: function (title, message, type, onConfirm) {
            const resolvedType = type || 'info';
            const overlay = document.createElement('div');
            overlay.className = 'alert-overlay alert-' + resolvedType;
            overlay.style.display = 'flex';

            overlay.innerHTML = `
                <div class="alert-card">
                    <div class="alert-icon">
                        <i data-lucide="${this.getIcon(resolvedType)}" size="32"></i>
                    </div>
                    <h3>${title}</h3>
                    <p>${message}</p>
                    <button class="alert-btn btn-confirm">Got it</button>
                </div>
            `;

            document.body.appendChild(overlay);
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }

            const btn = overlay.querySelector('.btn-confirm');
            if (btn) {
                btn.onclick = function () {
                    overlay.remove();
                    if (typeof onConfirm === 'function') {
                        onConfirm();
                    }
                };
            }
        },

        confirm: function (title, message, onYes) {
            const overlay = document.createElement('div');
            overlay.className = 'alert-overlay alert-warning';
            overlay.style.display = 'flex';

            overlay.innerHTML = `
                <div class="alert-card">
                    <div class="alert-icon"><i data-lucide="help-circle" size="32"></i></div>
                    <h3>${title}</h3>
                    <p>${message}</p>
                    <div style="display: flex; gap: 10px;">
                        <button class="alert-btn" id="btn-no" style="background:#f1f5f9; color:#64748b;">Cancel</button>
                        <button class="alert-btn btn-confirm" id="btn-yes">Proceed</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }

            const btnNo = overlay.querySelector('#btn-no');
            const btnYes = overlay.querySelector('#btn-yes');

            if (btnNo) {
                btnNo.onclick = function () {
                    overlay.remove();
                };
            }

            if (btnYes) {
                btnYes.onclick = function () {
                    overlay.remove();
                    if (typeof onYes === 'function') {
                        onYes();
                    }
                };
            }
        },

        getIcon: function (type) {
            if (type === 'success') {
                return 'check-circle';
            }
            if (type === 'error') {
                return 'alert-octagon';
            }
            if (type === 'warning') {
                return 'alert-triangle';
            }
            return 'info';
        }
    };

    window.AppAlert = AppAlert;

    const AppLoader = {
        isVisible: false,

        ensureDom: function () {
            if (document.getElementById('app-loader-overlay')) {
                return;
            }

            const overlay = document.createElement('div');
            overlay.id = 'app-loader-overlay';
            overlay.className = 'app-loader-overlay';
            overlay.setAttribute('aria-live', 'polite');
            overlay.setAttribute('aria-label', 'Loading');
            overlay.innerHTML = `
                <div class="app-loader-card" role="status">
                    <div class="app-loader-spinner" aria-hidden="true"></div>
                    <p class="app-loader-text">Working on it...</p>
                </div>
            `;

            document.body.appendChild(overlay);
        },

        show: function (message) {
            this.ensureDom();

            const overlay = document.getElementById('app-loader-overlay');
            const textEl = overlay ? overlay.querySelector('.app-loader-text') : null;

            if (textEl && message) {
                textEl.textContent = message;
            }

            if (overlay) {
                overlay.classList.add('is-active');
                document.body.classList.add('app-loading');
                this.isVisible = true;
            }
        },

        hide: function () {
            const overlay = document.getElementById('app-loader-overlay');
            if (overlay) {
                overlay.classList.remove('is-active');
            }

            document.body.classList.remove('app-loading');
            this.isVisible = false;
        }
    };

    window.AppLoader = AppLoader;

    function shouldShowForLink(link) {
        if (!link || !link.href) {
            return false;
        }

        if (link.dataset && link.dataset.noLoader === 'true') {
            return false;
        }

        if (link.target === '_blank' || link.hasAttribute('download')) {
            return false;
        }

        const hrefAttr = link.getAttribute('href') || '';
        if (hrefAttr === '#' || hrefAttr.startsWith('javascript:')) {
            return false;
        }

        const url = new URL(link.href, window.location.origin);

        if (url.origin !== window.location.origin) {
            return false;
        }

        const samePath = url.pathname === window.location.pathname;
        const onlyHashChange = samePath && url.search === window.location.search && url.hash;
        if (onlyHashChange) {
            return false;
        }

        return true;
    }

    document.addEventListener('click', function (event) {
        const anchor = event.target.closest('a');
        if (!shouldShowForLink(anchor)) {
            return;
        }

        AppLoader.show('Opening page...');
    });

    document.addEventListener('submit', function (event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
            return;
        }

        if (form.dataset && form.dataset.noLoader === 'true') {
            return;
        }

        AppLoader.show('Submitting request...');
    });

    window.addEventListener('pageshow', function () {
        AppLoader.hide();
    });

    window.addEventListener('load', function () {
        AppLoader.hide();
    });
})();
