/* ==========================================================================
   SLURM Cluster Manager JS Logic - Theme Switch & Simulator Bindings
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // ---------------------------------------------------------
    // 1. Color Theme Toggle & LocalStorage Persistence
    // ---------------------------------------------------------
    const themeToggleBtn = document.getElementById('theme-toggle');
    
    // Retrieve stored theme or default to light (no class)
    const storedTheme = localStorage.getItem('theme');
    if (storedTheme === 'dark') {
        document.body.classList.add('dark');
    } else {
        document.body.classList.remove('dark');
    }

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const isDark = document.body.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            showToast(`Theme switched to ${isDark ? 'Dark' : 'Light'} Mode`);
        });
    }

    // ---------------------------------------------------------
    // 2. Copy Command to Clipboard
    // ---------------------------------------------------------
    const btnCopy = document.getElementById('btn-copy-install');
    const cmdText = document.getElementById('install-cmd');

    if (btnCopy && cmdText) {
        btnCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(cmdText.textContent)
                .then(() => {
                    const copyIcon = btnCopy.querySelector('.copy-icon');
                    const checkIcon = btnCopy.querySelector('.check-icon');
                    
                    copyIcon.classList.add('hidden');
                    checkIcon.classList.remove('hidden');
                    showToast('Installation command copied');
                    
                    setTimeout(() => {
                        copyIcon.classList.remove('hidden');
                        checkIcon.classList.add('hidden');
                    }, 2000);
                })
                .catch(err => {
                    console.error('Copy failed:', err);
                });
        });
    }

    // ---------------------------------------------------------
    // 3. Emulator Sidebar Tab Switcher
    // ---------------------------------------------------------
    const tabTriggers = document.querySelectorAll('.tab-trigger');
    const panels = document.querySelectorAll('.emulator-panel');

    tabTriggers.forEach(trigger => {
        trigger.addEventListener('click', () => {
            tabTriggers.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            trigger.classList.add('active');
            const targetId = trigger.getAttribute('data-tab');
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
            }
        });
    });

    // ---------------------------------------------------------
    // 4. Job Items Toggle (Expand/Collapse)
    // ---------------------------------------------------------
    const jobItems = document.querySelectorAll('.job-item');

    jobItems.forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.job-actions') || e.target.closest('.logs-row')) {
                return;
            }
            item.classList.toggle('expanded');
        });
    });

    // ---------------------------------------------------------
    // 5. Job Action Buttons (Cancel / Pin)
    // ---------------------------------------------------------
    const cancelButtons = document.querySelectorAll('.cancel-btn');
    const pinButtons = document.querySelectorAll('.pin-btn');

    cancelButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const jobItem = btn.closest('.job-item');
            const jobId = jobItem.getAttribute('data-job-id');
            const jobName = jobItem.querySelector('.job-name').textContent;
            
            if (confirm(`Cancel job ${jobId} (${jobName})?`)) {
                jobItem.style.opacity = '0.3';
                jobItem.style.pointerEvents = 'none';
                showToast(`scancel issued for job ${jobId}`);
                
                setTimeout(() => {
                    jobItem.remove();
                    updateActiveJobBadge();
                }, 800);
            }
        });
    });

    pinButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const jobItem = btn.closest('.job-item');
            const jobId = jobItem.getAttribute('data-job-id');
            
            const isPinned = btn.classList.toggle('pinned');
            if (isPinned) {
                jobItem.classList.add('pinned-job');
                showToast(`Job ${jobId} pinned`);
            } else {
                jobItem.classList.remove('pinned-job');
                showToast(`Job ${jobId} unpinned`);
            }
        });
    });

    function updateActiveJobBadge() {
        const remainingJobs = document.querySelectorAll('.job-list .job-item').length;
        const badge = document.getElementById('active-jobs-badge');
        if (badge) badge.textContent = remainingJobs;
    }

    // ---------------------------------------------------------
    // 6. Simulated Log Viewer & Close Action
    // ---------------------------------------------------------
    const logButtons = document.querySelectorAll('.btn-open-log');
    const logTitle = document.getElementById('emulator-tab-title');
    const logBody = document.getElementById('log-content-body');
    const closeLogBtn = document.querySelector('.action-btn-mini');

    const logTemplates = {
        stdout: `
<span class="comment"># Tail of output logs for job 548910 (Updated 3 seconds ago)</span>
[Epoch 14/100] training_loss: 0.4561 | validation_loss: 0.5122
[Epoch 14] Batch 1500/2300: loss=0.4501, lr=1e-4
[Epoch 14] Batch 2000/2300: loss=0.4320, lr=1e-4
[Epoch 15/100] training_loss: 0.4109 | validation_loss: 0.4902
[Epoch 15] Batch 500/2300: loss=0.4022, lr=1e-4
[Epoch 15] Batch 1000/2300: loss=0.3951, lr=1e-4
[2026-06-14 02:08:44] Evaluation step completed.
[2026-06-14 02:08:45] Validation Accuracy: 94.21%
[2026-06-14 02:09:00] Saving checkpoint model_epoch_15.pt ...
[2026-06-14 02:09:12] Saved successfully. Moving to epoch 16.
<span class="cursor-line">_</span>`,
        stderr: `
<span class="comment"># Stderr traceback for job 548910</span>
[2026-06-14 02:05:18] Warning: PyTorch version mismatch. Expected CUDA 12.1.
[2026-06-14 02:05:19] UserWarning: Casting complex data types is experimental.
[2026-06-14 02:06:05] Traceback (most recent call last):
  File "train.py", line 245, in <module>
    loss.backward()
  File "/usr/local/lib/python3.10/dist-packages/torch/_tensor.py", line 487, in backward
    torch.autograd.backward(
  File "/usr/local/lib/python3.10/dist-packages/torch/autograd/__init__.py", line 200, in backward
    Variable._execution_engine.run_backward(
RuntimeError: CUDA out of memory. Tried to allocate 16.00 GiB (GPU 2; 79.35 GiB total capacity; 68.12 GiB already allocated).
<span class="cursor-line">_</span>`,
        infer_stdout: `
<span class="comment"># Inference stdout for job 548915</span>
[2026-06-14 02:06:01] Processing batch 1 of 50... Done (1.2s)
[2026-06-14 02:06:02] Processing batch 2 of 50... Done (1.1s)
[2026-06-14 02:06:03] Processing batch 3 of 50... Done (1.2s)
[2026-06-14 02:06:04] Processing batch 4 of 50... Done (1.4s)
[2026-06-14 02:06:06] Processing batch 5 of 50... Done (1.1s)
[2026-06-14 02:06:07] Processing batch 6 of 50... Done (1.1s)
[2026-06-14 02:06:08] Processing batch 7 of 50... Done (1.2s)
<span class="cursor-line">_</span>`,
        infer_stderr: `
<span class="comment"># Inference stderr for job 548915</span>
[2026-06-14 02:06:00] CUDA initialized successfully.
[2026-06-14 02:06:01] WARNING: Batch size 128 exceeds recommended L2 cache size.
[2026-06-14 02:06:04] WARNING: Disk write speeds lagging behind processing throughput.
<span class="cursor-line">_</span>`
    };

    logButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const logKey = btn.getAttribute('data-log');
            const jobItem = btn.closest('.job-item');
            const jobId = jobItem.getAttribute('data-job-id');
            const isError = logKey.includes('stderr');
            
            if (logTitle && logBody && logTemplates[logKey]) {
                logTitle.textContent = `job_${jobId}_${isError ? 'stderr' : 'stdout'}.log`;
                logBody.innerHTML = logTemplates[logKey];
                showToast(`Opened ${isError ? 'stderr' : 'stdout'} log for job ${jobId}`);
            }
        });
    });

    if (closeLogBtn) {
        closeLogBtn.addEventListener('click', () => {
            if (logTitle && logBody) {
                logTitle.textContent = 'No log file open';
                logBody.innerHTML = '<span class="comment"># Select a job in the sidebar and click stdout/stderr to inspect live output.</span>';
                showToast('Closed active log viewer');
            }
        });
    }

    // ---------------------------------------------------------
    // 7. Refresh Simulator
    // ---------------------------------------------------------
    const btnRefresh = document.getElementById('btn-emulator-refresh');
    const lblUpdate = document.getElementById('lbl-emulator-last-update');

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            btnRefresh.style.transform = 'rotate(360deg)';
            btnRefresh.style.transition = 'transform 0.4s ease';
            
            setTimeout(() => {
                btnRefresh.style.transform = 'none';
                btnRefresh.style.transition = 'none';
                
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                
                if (lblUpdate) {
                    lblUpdate.textContent = `Connected • Refreshed at ${timeStr}`;
                }
                showToast('Slurm Explorer refreshed');
            }, 400);
        });
    }

    // ---------------------------------------------------------
    // 8. Settings Dashboard Interactivity
    // ---------------------------------------------------------
    const cfgInterval = document.getElementById('cfg-interval');
    const cfgIntervalVal = document.getElementById('cfg-interval-val');
    const cfgRefresh = document.getElementById('cfg-refresh-enabled');
    const cfgShameSize = document.getElementById('cfg-shame-size');
    const cfgMock = document.getElementById('cfg-mock-mode');

    if (cfgInterval && cfgIntervalVal) {
        cfgInterval.addEventListener('input', () => {
            cfgIntervalVal.textContent = `${cfgInterval.value}s`;
        });
        cfgInterval.addEventListener('change', () => {
            showToast(`Setting 'autoRefreshInterval' updated to ${cfgInterval.value}s`);
        });
    }

    if (cfgRefresh) {
        cfgRefresh.addEventListener('change', () => {
            showToast(`Setting 'autoRefreshEnabled' set to ${cfgRefresh.checked}`);
        });
    }

    if (cfgShameSize) {
        cfgShameSize.addEventListener('change', () => {
            showToast(`Setting 'leaderboardTopUserCount' updated to ${cfgShameSize.value}`);
        });
    }

    if (cfgMock) {
        cfgMock.addEventListener('change', () => {
            showToast(`Setting 'mockMode' set to ${cfgMock.checked}`);
        });
    }

    // ---------------------------------------------------------
    // 9. Setup Guide Tabs Switcher
    // ---------------------------------------------------------
    const setupTabBtns = document.querySelectorAll('.setup-tab-btn');
    const setupPanels = document.querySelectorAll('.setup-content-panel');

    setupTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setupTabBtns.forEach(b => b.classList.remove('active'));
            setupPanels.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const targetPanelId = btn.getAttribute('data-setup');
            const targetPanel = document.getElementById(targetPanelId);
            if (targetPanel) {
                targetPanel.classList.add('active');
            }
        });
    });

    // ---------------------------------------------------------
    // 10. Toast Notification System
    // ---------------------------------------------------------
    const toast = document.getElementById('toast');
    let toastTimeout;

    function showToast(message, duration = 2500) {
        if (!toast) return;

        const toastMsg = toast.querySelector('.toast-message');
        toastMsg.textContent = message;

        clearTimeout(toastTimeout);
        toast.classList.remove('hidden');

        toastTimeout = setTimeout(() => {
            toast.classList.add('hidden');
        }, duration);
    }

    const toastClose = document.querySelector('.toast-close');
    if (toastClose && toast) {
        toastClose.addEventListener('click', () => {
            toast.classList.add('hidden');
            clearTimeout(toastTimeout);
        });
    }

    // ---------------------------------------------------------
    // 11. Mobile Menu Toggle
    // ---------------------------------------------------------
    const menuToggle = document.querySelector('.mobile-menu-toggle');
    const navLinks = document.querySelector('.nav-links');

    if (menuToggle && navLinks) {
        menuToggle.addEventListener('click', () => {
            const isVisible = navLinks.style.display === 'flex';
            if (isVisible) {
                navLinks.style.display = 'none';
            } else {
                navLinks.style.display = 'flex';
                navLinks.style.flexDirection = 'column';
                navLinks.style.position = 'absolute';
                navLinks.style.top = '100%';
                navLinks.style.left = '0';
                navLinks.style.width = '100%';
                navLinks.style.background = 'var(--bg-color)';
                navLinks.style.borderBottom = '1px solid var(--border-color)';
                navLinks.style.padding = '20px';
                navLinks.style.gap = '12px';
            }
        });
    }
});
