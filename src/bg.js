/* Toolbar button and keyboard shortcuts -> tell the content script. */
const send = async (msg) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://timetreeapp.com/')) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
};

chrome.action.onClicked.addListener(() => send('ttx:toggle'));
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-panel') send('ttx:toggle');
  if (cmd === 'toggle-dark') send('ttx:dark');
});
