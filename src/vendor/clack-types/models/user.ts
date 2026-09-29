/** 모노레포 clack-types/models/user.ts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
import type { MannerTemperature } from './trade-review.js';

/**
 * 클랙 레벨(구 매너온도 개편) — 점수 기반 레벨, 마이너스 레벨 존재.
 * 본인/타인 계약 차등: public 응답은 level/color/icon만, me 응답은 points/next_level_points 포함.
 */
export type UserLevel = {
  level: number; // 음수 가능 (Lv.−5 ~ Lv.10), 그대로 노출
  color: string;
  icon: string; // 레벨 티어 아이콘 키 (이모지 아님)
  points?: number; // me 계열 응답에만 포함
  next_level_points?: number | null; // me 계열만 — 다음 레벨까지 잔여, Lv.10이면 null
  level_progress?: number | null; // me 계열만 — 현재 레벨 구간 내 진행률(0~1, 게이지용), Lv.10이면 null
};

/** v4 임베디드 응답에서 재사용되는 최소 유저 정보 */
export type UserSummary = {
  id: number | null;
  name: string | null;
  avatar: string | null;
  twitter?: string | null;
  identity_verification_id: number | null;
  admin_granted_verified: boolean;
  admin_verified: boolean;
};

/** 익명 게시판/알림에서 노출되는 익명 유저 정보 */
export type AnonymousUserSummary = UserSummary & {
  id: null;
  name: string;
  avatar: null;
  twitter: null;
  identity_verification_id: null;
  admin_granted_verified: false;
  admin_verified: false;
};

export type PublicUserProfile = UserSummary & {
  custom_page?: import('../custom-pages.js').CustomPageDescriptor | null;
  instagram: string | null;
  birth: string | null;
  seller_intro: string | null;
  created_at: string | null;
  manner_temperature?: MannerTemperature;
  user_level?: UserLevel;
};

export type User = {
  /** 앱에서 동기화한 화면 언어. 내 정보 조회에서만 제공한다. */
  app_language?: 'ko' | 'en';
  id: number;
  type: string;
  uid: string | null;
  email: string;
  name: string;
  nickname: string | null;
  avatar: string | null;
  instagram: string | null;
  twitter: string | null;
  seller_intro: string | null;
  gender_id: number | null;
  birth: string | null;
  allow_notification: boolean;
  points: number;
  account_name: string | null;
  bank: string | null;
  account_number: string | null;
  marketing_push_consent: boolean | null;
  marketing_push_consent_at: string | null;
  email_notification_enabled: boolean;
  notification_email: string | null;
  notification_email_verified_at: string | null;
  block_at: string | null;
  restricted: boolean;
  restricted_at: string | null;
  restriction_reason: string | null;
  identity_verification_id: number | null;
  leave_at: string | null;
  admin_granted_verified: boolean;
  admin_verified: boolean;
  created_at: string | null;
  updated_at: string | null;
  manner_temperature?: MannerTemperature;
  user_level?: UserLevel;
  /** 앱인클랙 워크스페이스 멤버 여부 — GET /v4/me 에서만 세팅(다른 serializeUser 소비 라우트는 미포함, 부재 시 false 취급) */
  mini_app_workspace_member?: boolean;
};

export type SellerIntroUpdate = {
  seller_intro: string;
};

export type MarketingPushConsentUpdate = {
  marketing_push_consent: boolean;
  marketing_push_consent_at: string | null;
};

export type IdentityVerificationLinkResult = {
  identity_verification_id: number;
};
