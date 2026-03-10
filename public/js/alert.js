const AppAlert = {
    show: function(title, message, type = 'info', onConfirm = null) {
        // Create elements
        const overlay = document.createElement('div');
        overlay.className = `alert-overlay alert-${type}`;
        overlay.style.display = 'flex';

        overlay.innerHTML = `
            <div class="alert-card">
                <div class="alert-icon">
                    <i data-lucide="${this.getIcon(type)}" size="32"></i>
                </div>
                <h3>${title}</h3>
                <p>${message}</p>
                <button class="alert-btn btn-confirm">Got it</button>
            </div>
        `;

        document.body.appendChild(overlay);
        lucide.createIcons();

        // Close logic
        const btn = overlay.querySelector('.btn-confirm');
        btn.onclick = () => {
            overlay.remove();
            if (onConfirm) onConfirm();
        };
    },

    confirm: function(title, message, onYes) {
        const overlay = document.createElement('div');
        overlay.className = `alert-overlay alert-warning`;
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
        lucide.createIcons();

        overlay.querySelector('#btn-no').onclick = () => overlay.remove();
        overlay.querySelector('#btn-yes').onclick = () => {
            overlay.remove();
            onYes();
        };
    },

    getIcon: function(type) {
        if (type === 'success') return 'check-circle';
        if (type === 'error') return 'alert-octagon';
        if (type === 'warning') return 'alert-triangle';
        return 'info';
    }
};