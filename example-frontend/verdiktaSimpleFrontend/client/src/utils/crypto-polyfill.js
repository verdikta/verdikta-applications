// crypto-polyfill.js
import { v4 as uuidv4 } from 'uuid';

// Make sure crypto object exists
if (typeof window !== 'undefined') {
  if (!window.crypto) {
    window.crypto = {};
  }
  
  // Implement randomUUID using the uuid package
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = function() {
      return uuidv4();
    };
  }
}
