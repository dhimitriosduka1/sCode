// Each clip's shape (width / height), so the player takes the right size before a clip loads.
const WALKTHROUGH = '1440 / 1170';
const EDITOR = '1920 / 1200';
const SIDEBAR = '1640 / 1720';

// These clips contain the original recordings, including the animated feature demos.
const recordings = {
  overview: [
    { title: 'From script to logs', src: 'assets/demos/walkthrough.mp4', shape: WALKTHROUGH, description: 'A whole session in under two minutes: check the cluster, write a training script with the partition and GPUs suggested, submit it, queue an evaluation behind it, and read the logs.' },
  ],
  scripts: [
    { title: 'Partition suggestions', src: 'assets/demos/submit-partitions.mp4', shape: EDITOR, description: 'Partitions are suggested as you type, GPU partitions first and the least busy on top. Pick one without the GPU type you asked for and the request is flagged. Hover a partition for its load.' },
    { title: 'GPU types', src: 'assets/demos/gpu-types.mp4', shape: EDITOR, description: 'Type --gres=gpu: and you’re offered only the GPU types your partitions have, with how many are idle. It works the same for --gpus, -G, and the --gpus-per-* options.' },
  ],
  jobs: [
    { title: 'Details and priority', src: 'assets/demos/active-jobs.mp4', shape: SIDEBAR, description: 'Expand a job for its resources, time limit, and log files. Hover a pending job to see what its priority is made of, or your fair share to compare your accounts.' },
    { title: 'Hold, release, cancel', src: 'assets/demos/job-actions.mp4', shape: SIDEBAR, description: 'Hold a pending job so it can’t start, and release it when you’re ready. Cancel asks first. Use the checkboxes, or the Running and Pending rows, to act on many jobs at once.' },
    { title: 'Job arrays', src: 'assets/demos/job-arrays.mp4', shape: SIDEBAR, description: 'Change how many tasks may run at once without resubmitting the array. Cancel all of it, only the tasks still waiting, or indices like 8-10 or 0-20:2.' },
    { title: 'Dependencies', src: 'assets/demos/dependencies.mp4', shape: SIDEBAR, description: 'Make a pending job wait for others, with afterok or another condition, and clear it again when plans change. To set one at submit time, use the link button next to ▶.' },
    { title: 'Search', src: 'assets/demos/search.mp4', shape: SIDEBAR, description: 'Type part of a job name, an ID, or a pending reason, and Active Jobs narrows to what matches. Clear the search to see everything again.' },
  ],
  logs: [
    { title: 'Stdout and stderr', src: 'assets/demos/logs.mp4', shape: EDITOR, description: 'Open a job’s stdout or stderr from its row, or both side by side. Log paths with %j, %x, %a, or ~ are worked out for you, so there’s no hunting for slurm-91001.out.' },
  ],
  cluster: [
    { title: 'Partition usage', src: 'assets/demos/partition-usage.mp4', shape: SIDEBAR, description: 'GPU partitions sorted by how busy they are, with upcoming maintenance flagged at the top. Expand one for idle GPUs, node states, and the jobs running or waiting there.' },
    { title: 'Cluster overview', src: 'assets/demos/cluster-overview.mp4', shape: SIDEBAR, description: 'Which accounts hold the cluster’s GPUs, of which types, and their share of everything allocated. Hover an account to see the users behind the number.' },
    { title: 'Hall of Shame', src: 'assets/demos/hall-of-shame.mp4', shape: SIDEBAR, description: 'Users ranked by the GPUs they’re holding, with 💀 🔥 👹 for the top three. Hover a name for their account, GPU types, and fair share. Your own row always shows, wherever you rank.' },
  ],
  history: [
    { title: 'Job history', src: 'assets/demos/job-history.mp4', shape: SIDEBAR, description: 'Finished jobs grouped by day, failed and timed-out ones included. Expand one for its exit code, peak memory, and logs. Look back a day, a week, 30 days, or up to a year.' },
  ],
};

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panel = document.querySelector('#product-panel');
const video = document.querySelector('#product-video');
const recordingList = document.querySelector('.recordings');
const description = document.querySelector('#viewer-description');
const viewerStatus = document.querySelector('#viewer-status');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let activeGroup = 'overview';
let playAfterLoad = !reducedMotion.matches;

function showRecording(index) {
  const recording = recordings[activeGroup][index];
  for (const [i, button] of [...recordingList.children].entries()) button.setAttribute('aria-pressed', String(i === index));
  // Preserve an explicit pause while browsing. Reduced-motion users start playback themselves.
  if (panel.getAttribute('aria-busy') !== 'true') playAfterLoad = !video.paused;
  playAfterLoad = playAfterLoad && !reducedMotion.matches;
  video.pause();
  viewerStatus.textContent = '';
  panel.setAttribute('aria-busy', 'true');
  video.setAttribute('aria-label', recording.title);
  video.style.setProperty('--ratio', recording.shape);
  video.src = recording.src;
  description.textContent = recording.description;
  video.load();
}

function listRecordings() {
  recordingList.replaceChildren(...recordings[activeGroup].map((recording, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = recording.title;
    button.setAttribute('aria-pressed', String(index === 0));
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') !== 'true') showRecording(index);
    });
    return button;
  }));
}

function selectTab(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  activeGroup = tab.dataset.group;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', tab.id);
  listRecordings();
  showRecording(0);
}

video.addEventListener('loadedmetadata', () => {
  if (video.videoWidth) video.style.setProperty('--ratio', `${video.videoWidth} / ${video.videoHeight}`);
  panel.setAttribute('aria-busy', 'false');
  if (playAfterLoad) video.play().catch(() => {}); // If autoplay is blocked, clicking the video starts it.
});
video.addEventListener('error', () => {
  panel.setAttribute('aria-busy', 'false');
  viewerStatus.textContent = 'This recording didn’t load. Try another one, or reload the page.';
});
reducedMotion.addEventListener('change', event => {
  if (event.matches) {
    playAfterLoad = false;
    video.pause();
  }
});

document.querySelector('.viewer-tabs').hidden = false;
document.querySelector('.recording-row').hidden = false;
panel.setAttribute('role', 'tabpanel');
panel.setAttribute('aria-labelledby', tabs[0].id);
listRecordings();
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    selectTab(tabs[next]);
  });
}

if (!reducedMotion.matches) video.play().catch(() => {});

// There are no player controls, so the video itself toggles playback by click or keyboard.
function togglePlayback() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
video.tabIndex = 0;
video.addEventListener('click', togglePlayback);
video.addEventListener('keydown', event => {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  togglePlayback();
});

// Clipboard access can be denied. Leave the command selectable in that case.
const copyButton = document.querySelector('.copy-command');
const copyStatus = document.querySelector('#copy-status');
let copyReset;
if (navigator.clipboard?.writeText) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    clearTimeout(copyReset);
    try {
      await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);
      copyButton.textContent = 'Copied';
      copyStatus.textContent = 'Copied. Paste it into Quick Open.';
    } catch {
      copyButton.textContent = 'Copy';
      copyStatus.textContent = 'Couldn’t copy. Select the command and press Ctrl+C or ⌘C.';
    }
    copyReset = setTimeout(() => {
      copyButton.textContent = 'Copy';
      copyStatus.textContent = '';
    }, 4000);
  });
}

// The notice scrolls as a ticker. Screen readers keep the original sentence; the moving copies are hidden from them.
const notice = document.querySelector('.site-notice');
const noticeText = notice.querySelector('.notice-text').textContent;
const tickerHalf = () => {
  const half = document.createElement('div');
  half.className = 'ticker-half';
  for (let i = 0; i < 6; i++) {
    const item = document.createElement('span');
    item.textContent = noticeText;
    half.append(item);
  }
  return half;
};
const ticker = document.createElement('div');
ticker.className = 'ticker';
ticker.setAttribute('aria-hidden', 'true');
ticker.append(tickerHalf(), tickerHalf());
notice.append(ticker);
notice.classList.add('is-ticker');

// The page is light until the toggle switches it to dark, which is remembered.
const root = document.documentElement;
const themeToggle = document.querySelector('.theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeColors = { light: '#f8f9f6', dark: '#121513' };

function applyTheme() {
  const mode = root.dataset.theme === 'dark' ? 'dark' : 'light';
  root.dataset.mode = mode;
  themeToggle.setAttribute('aria-label', `Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`);
  themeColor.content = themeColors[mode];
}

themeToggle.hidden = false;
themeToggle.addEventListener('click', () => {
  const dark = root.dataset.mode !== 'dark';
  try {
    if (dark) localStorage.setItem('theme', 'dark');
    else localStorage.removeItem('theme');
  } catch {}
  if (dark) root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  applyTheme();
});
applyTheme();
