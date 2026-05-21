/**
 * Toast Notification System
 * Provides non-blocking notifications that auto-dismiss
 */

import { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import './Toast.css';

// Context for toast notifications
const ToastContext = createContext(null);

// Toast types with their icons and styles
const TOAST_CONFIG = {
  success: {
    icon: CheckCircle,
    className: 'toast-success',
  },
  error: {
    icon: XCircle,
    className: 'toast-error',
  },
  warning: {
    icon: AlertTriangle,
    className: 'toast-warning',
  },
  info: {
    icon: Info,
    className: 'toast-info',
  },
};

// Default duration in milliseconds
const DEFAULT_DURATION = 2000;

/**
 * Individual Toast component
 */
function ToastItem({ toast, onDismiss }) {
  const config = TOAST_CONFIG[toast.type] || TOAST_CONFIG.info;
  const Icon = config.icon;

  return (
    <div className={`toast ${config.className}`} role="alert">
      <Icon size={20} className="toast-icon" />
      <span className="toast-message">{toast.message}</span>
      <button
        className="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X size={16} />
      </button>
    </div>
  );
}

/**
 * Toast container that renders all active toasts
 */
function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/**
 * Toast Provider component
 * Wrap your app with this to enable toast notifications
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', duration = DEFAULT_DURATION) => {
    const id = Date.now() + Math.random();

    setToasts((prev) => [...prev, { id, message, type }]);

    // Auto-dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        dismissToast(id);
      }, duration);
    }

    return id;
  }, [dismissToast]);

  // Convenience methods for each toast type
  const toast = useCallback((message, duration) => addToast(message, 'info', duration), [addToast]);
  toast.success = useCallback((message, duration) => addToast(message, 'success', duration), [addToast]);
  toast.error = useCallback((message, duration) => addToast(message, 'error', duration), [addToast]);
  toast.warning = useCallback((message, duration) => addToast(message, 'warning', duration), [addToast]);
  toast.info = useCallback((message, duration) => addToast(message, 'info', duration), [addToast]);
  toast.dismiss = dismissToast;

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

/**
 * Hook to use toast notifications
 * @returns {Function} toast function with success, error, warning, info methods
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success('Copied to clipboard');
 *   toast.error('Something went wrong');
 *   toast('Default info message');
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
