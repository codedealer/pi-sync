const fs = require('node:fs/promises');
const originalRename = fs.rename;
let injected = false;

fs.rename = async (source, destination) => {
  if (!injected && process.env.PI_SYNC_FAIL_RENAME_FROM === source && destination.endsWith('.old')) {
    injected = true;
    const error = new Error('injected initial target rename failure');
    error.code = 'EIO';
    throw error;
  }
  return originalRename(source, destination);
};
