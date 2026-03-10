// CUSTOM PROFESSIONAL MODAL SYSTEM
const CustomModal = {
    show: function(title, message, onConfirm) {
        // Create modal elements
        const overlay = document.createElement('div');
        overlay.className = 'custom-modal-overlay animate-fade-in';
        
        overlay.innerHTML = `
            <div class="custom-modal-card animate-pop-in">
                <div class="modal-icon"><i data-lucide="help-circle"></i></div>
                <h3>${title}</h3>
                <p>${message}</p>
                <div class="modal-actions">
                    <button id="modal-cancel" class="btn-ghost">Cancel</button>
                    <button id="modal-confirm" class="btn-danger">Yes, Delete</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(overlay);
        lucide.createIcons();

        // Handle buttons
        document.getElementById('modal-cancel').onclick = () => {
            overlay.classList.add('animate-fade-out');
            setTimeout(() => overlay.remove(), 300);
        };

        document.getElementById('modal-confirm').onclick = () => {
            overlay.remove();
            onConfirm();
        };
    }
};

// Form Input Micro-interactions
document.querySelectorAll('.input-group input').forEach(input => {
    input.onfocus = () => input.parentElement.classList.add('active');
    input.onblur = () => input.parentElement.classList.remove('active');
});

// PRO TOAST NOTIFICATION SYSTEM
const ProToast = {
    show: function(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `pro-toast animate-pop-in ${type}`;
        
        const icon = type === 'success' ? 'check-circle' : 'alert-circle';
        
        toast.innerHTML = `
            <div class="toast-content">
                <i data-lucide="${icon}"></i>
                <span>${message}</span>
            </div>
        `;
        
        document.body.appendChild(toast);
        lucide.createIcons();

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 500);
        }, 4000);
    }
};

// CSS for the toast (Add to style.css)
/*
.pro-toast {
    position: fixed; top: 20px; left: 20px; right: 20px; z-index: 9999;
    background: white; padding: 16px; border-radius: 16px; 
    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); border-left: 6px solid #22c55e;
}
.pro-toast.error { border-left-color: #ef4444; }
.toast-content { display: flex; align-items: center; gap: 12px; font-weight: 700; color: #1e293b; }
*/