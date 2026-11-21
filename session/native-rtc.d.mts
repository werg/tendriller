import type { NativeRtcOptions } from '@chronolog/peer-session/webrtc-native';
import { participateApplication } from './participation.mjs';

export type NativeApplicationParticipationOptions = Omit<Parameters<typeof participateApplication>[1], 'openDirectConnection'> & {
  /** Optional local ICE interface/port constraints; shared configuration supplies STUN/TURN. */
  readonly native?: NativeRtcOptions;
};
/** Node-only RTC factory with the canonical direct-first participation policy. */
export function participateNativeApplication(
  session: Parameters<typeof participateApplication>[0],
  options: NativeApplicationParticipationOptions,
): ReturnType<typeof participateApplication>;
