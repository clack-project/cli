/** 모노레포 clack-types/models/trade-review.ts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
import type { UserLevel, UserSummary } from './user.js';

export type TradeReviewTag = {
  id: number;
  code: string;
  label: string;
  type: 'manner' | 'unmanner';
  target_role: 'buyer' | 'seller' | 'both';
  score_delta: number;
  requires_comment: boolean;
  sort_order: number;
};

export type TradeReviewTagSelectionInput = {
  tag_id: number;
  comment?: string | null;
};

export type TradeReviewCreateInput = {
  order_type: 'used';
  order_id: number;
  satisfaction: 'negative' | 'positive' | 'great';
  tags: TradeReviewTagSelectionInput[];
  comment?: string | null;
};

export type TradeReview = {
  id: number;
  order_type: 'used';
  order_id: number;
  reviewer_id: number;
  reviewee_id: number;
  reviewer_role: 'buyer' | 'seller';
  satisfaction: 'negative' | 'positive' | 'great';
  comment: string | null;
  created_at: string | null;
};

export type TradeReviewListItem = TradeReview & {
  reviewer: UserSummary;
};

/** 내가 받은/보낸 후기 목록 아이템 — other_user는 상대방 (받은 후기면 reviewer, 보낸 후기면 reviewee) */
export type MyTradeReviewListItem = TradeReview & {
  other_user: UserSummary;
};

export type TradeReviewTagListResponse = {
  reviewer_role: 'buyer' | 'seller';
  manner_tags: TradeReviewTag[];
  unmanner_tags: TradeReviewTag[];
};

export type TradeReviewReportInput = {
  subject: string;
  content: string;
};

export type TradeReviewStatus = {
  order_type: 'used';
  order_id: number;
  can_write: boolean;
  my_role: 'buyer' | 'seller' | null;
  review_opened_at: string | null;
  deadline_at: string | null;
  written_by_me: boolean;
  written_by_other_side: boolean;
  reason:
    | 'ok'
    | 'not_authenticated'
    | 'not_participant'
    | 'not_completed'
    | 'review_window_not_started'
    | 'expired'
    | 'already_written'
    | 'unsupported_order_type'
    | 'order_not_found';
};

export type MannerTemperature = {
  value: number;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  color: string;
  emoji: string;
};

export type PublicTradeReviewSummary = {
  manner_temperature: MannerTemperature;
  user_level?: UserLevel;
  total_reviews: number;
  satisfaction_count: {
    negative: number;
    positive: number;
    great: number;
  };
  manner_tags: Array<{
    tag: TradeReviewTag;
    count: number;
  }>;
};

export type MyTradeReviewSummary = PublicTradeReviewSummary & {
  negative_count: number;
};
