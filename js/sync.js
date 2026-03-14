/**
 * sync.js — BroadcastChannel wrapper for cross-tab communication
 * Channel: 'saborjarocho-sync'
 */

const channel = new BroadcastChannel('saborjarocho-sync');

/**
 * Post a message to all other tabs
 * @param {object} message
 */
export function broadcast(message) {
  try {
    channel.postMessage(message);
  } catch (e) {
    console.warn('BroadcastChannel post failed:', e);
  }
}

/**
 * Listen for messages from other tabs
 * @param {function} callback - called with the message data object
 */
export function listenSync(callback) {
  channel.onmessage = (event) => {
    if (event && event.data) {
      callback(event.data);
    }
  };
}
