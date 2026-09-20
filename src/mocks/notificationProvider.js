import { providerCall } from '../utils/provider.js';

/**
 * MOCK — Notification Provider. One call fans out to every enabled channel and
 * reports a per-channel delivery receipt, exactly like a real messaging gateway.
 */
const CHANNEL_PROVIDER = {
  push: 'TravelGuard Push (FCM) · mock',
  sms: 'Transactional SMS gateway · mock',
  email: 'Postmark · mock',
  whatsapp: 'WhatsApp Business API · mock',
};

export async function sendNotification({ notification, channels = ['push'], silent = true }) {
  return providerCall(
    'NotificationProvider',
    () => ({
      provider: 'Notification gateway · mock',
      notificationId: notification.id,
      sentAt: new Date().toISOString(),
      receipts: channels.map((channel) => ({
        channel,
        provider: CHANNEL_PROVIDER[channel] || 'Unknown',
        status: channel === 'sms' && Math.random() < 0.1 ? 'RETRYING' : 'DELIVERED',
        latencyMs: Math.round(80 + Math.random() * 420),
      })),
    }),
    { silent, multiplier: 0.6 },
  );
}
