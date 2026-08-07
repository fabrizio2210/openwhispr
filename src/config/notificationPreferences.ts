import snapshotModule from "./notificationPreferenceSnapshot.cjs";

export type NotificationPreferenceSnapshot = Record<string, boolean | number>;

export const createNotificationPreferenceSnapshot =
  snapshotModule.createNotificationPreferenceSnapshot as (
    source: object
  ) => NotificationPreferenceSnapshot;
