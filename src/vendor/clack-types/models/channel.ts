/** 모노레포 clack-types/models/channel.ts에서 복사한 파일이다. 이 파일을 직접 수정하지 말고
 * `scripts/sync-vendor-types.mjs`로 갱신한다. */
import type { UserSummary } from './user.js';

// ─── 블록 JSON 포맷 (API 명세 §0-4) ─────────────────────────────
// channel_posts.content = JSON.stringify(PostBlock[])
// 서버가 결제선(paywall_offset) 기준으로 배열을 절단해 응답한다 — 프론트 가리기 방식 금지.

/** 문단 내 부분 서식. range 는 text 기준 [시작, 끝) 문자 인덱스 */
export type PostBlockMark = {
  range: [number, number];
  style: 'bold' | 'italic' | 'link';
  /** style='link' 일 때만. http(s) 스킴만 허용(저장형 XSS 차단 — 서버 Zod·렌더러 이중 검증) */
  href?: string;
};

export type PostParagraphBlock = {
  type: 'paragraph';
  text: string;
  marks?: PostBlockMark[];
};

export type PostImageBlock = {
  type: 'image';
  /** 자사 CDN 호스트만 허용(URL 파싱 후 호스트 완전 일치 — 문자열 포함 검사 금지) */
  url: string;
  width: number;
  height: number;
  alt?: string;
};

export type PostDividerBlock = {
  type: 'divider';
};

export type PostBlock = PostParagraphBlock | PostImageBlock | PostDividerBlock;

/** 블록·발행 옵션 한도 — 서버 Zod 검증과 웹 에디터가 공유하는 SSOT */
export const POST_BLOCK_LIMITS = {
  /** 포스트당 최대 블록 수 */
  MAX_BLOCKS: 500,
  /** paragraph 블록 최대 글자 수 */
  MAX_PARAGRAPH_LENGTH: 20000,
  /** 제목 최대 길이 */
  MAX_TITLE_LENGTH: 200,
  /** 태그 최대 개수 / 태그당 최대 길이 */
  MAX_TAGS: 10,
  MAX_TAG_LENGTH: 50,
  /** 검색 스니펫으로 저장하는 무료 구간 앞 글자 수 */
  PREVIEW_TEXT_LENGTH: 200,
} as const;

/** 유료 포스트 가격 정책 (Phase 3) */
export const CHANNEL_POST_PRICE = {
  MIN: 100,
  MAX: 500000,
  /** 가격 단위 — 10P 단위만 허용 */
  STEP: 10,
} as const;

/** 채널 슬러그 정책 */
export const CHANNEL_SLUG = {
  PATTERN: /^[a-z0-9-]{3,30}$/,
  MIN_LENGTH: 3,
  MAX_LENGTH: 30,
  MAX_NAME_LENGTH: 45,
} as const;

// ─── 채널 ───────────────────────────────────────────────────────

export type ChannelStatus = 'active' | 'hidden' | 'suspended';

/** 카드·브레드크럼 등에 임베드되는 최소 채널 정보 */
export type ChannelSummary = {
  id: number;
  slug: string;
  name: string;
  avatar_image: string | null;
};

/** 채널 홈 헤더 */
export type Channel = ChannelSummary & {
  description: string | null;
  cover_image: string | null;
  status: ChannelStatus;
  owner: UserSummary;
  subscriber_count: number;
  post_count: number;
  /** 로그인 시에만 의미 있음 */
  is_subscribed: boolean;
  is_owner: boolean;
  created_at: string | null;
};

export type ChannelCreateInput = {
  name: string;
  slug: string;
  description?: string | null;
  avatar_image?: string | null;
  cover_image?: string | null;
};

export type ChannelUpdateInput = Partial<Omit<ChannelCreateInput, 'slug'>>;

// ─── 시리즈 ─────────────────────────────────────────────────────

export type ChannelSeriesSummary = {
  id: number;
  title: string;
};

/** 시리즈 목록 카드 */
export type ChannelSeriesCard = ChannelSeriesSummary & {
  description: string | null;
  cover_image: string | null;
  is_completed: boolean;
  /** 소속 포스트 중 성인물이 하나라도 있으면 true (커버 블러 판정) */
  is_adult: boolean;
  post_count: number;
  total_view: number;
  total_like: number;
};

export type ChannelSeriesDetail = ChannelSeriesCard & {
  channel: ChannelSummary;
  created_at: string | null;
};

// ─── 채널 포스트 ────────────────────────────────────────────────

export type ChannelPostStatus = 'draft' | 'published' | 'hidden' | 'admin_hidden';

/** 목록 카드 — 채널 홈·검색·피드·보관함 공통 */
export type ChannelPostCard = {
  id: number;
  title: string;
  /** 성인물이면서 열람 자격이 없으면 null (원본 URL 미전송) */
  thumbnail: string | null;
  is_adult: boolean;
  /** null = 무료 */
  price_points: number | null;
  /** 로그인 시에만 의미 있음 (Phase 3) */
  is_purchased: boolean;
  page_view: number;
  like_count: number;
  comment_count: number;
  published_at: string | null;
  channel: ChannelSummary;
  series: ChannelSeriesSummary | null;
  series_order: number | null;
  tags: string[];
  /** 무료 구간에서만 추출한 미리보기 (검색 결과용) */
  preview_text?: string | null;
};

/** 소유자 전용 — 임시저장 목록 아이템 */
export type ChannelPostDraftItem = Pick<
  ChannelPostCard,
  'id' | 'title' | 'thumbnail' | 'is_adult' | 'price_points' | 'series' | 'series_order'
> & {
  status: ChannelPostStatus;
  created_at: string | null;
  updated_at: string | null;
};

/** 뷰어 상태 — 서버가 판정해 내려준다 */
export type ChannelPostViewerState = 'full' | 'paywalled' | 'adult_gate';

export type ChannelPostAdultGateReason = 'unverified' | 'expired' | 'opt_out' | 'platform_blocked';

export type ChannelPostPaywall = {
  offset: number;
  price_points: number;
  /** 유료 구간 분량 — 결제선 박스 표기용 */
  paid_text_count: number;
  paid_image_count: number;
  /** paid_posts 플래그 ON 여부 */
  purchasable: boolean;
};

export type ChannelPostSeriesNav = ChannelSeriesSummary & {
  prev_id: number | null;
  next_id: number | null;
};

/** 포스트 뷰어 상세 */
export type ChannelPostDetail = {
  post: {
    id: number;
    title: string;
    channel: ChannelSummary;
    series: ChannelPostSeriesNav | null;
    series_order: number | null;
    is_adult: boolean;
    price_points: number | null;
    published_at: string | null;
    page_view: number;
    like_count: number;
    comment_count: number;
    tags: string[];
    is_liked: boolean;
    is_scrapped: boolean;
    is_purchased: boolean;
    is_owner: boolean;
  };
  viewer_state: ChannelPostViewerState;
  /** 상태별로 서버가 절단한 블록. adult_gate 면 빈 배열 */
  content: PostBlock[];
  paywall?: ChannelPostPaywall;
  adult_gate?: { reason: ChannelPostAdultGateReason };
};

export type ChannelPostCreateInput = {
  channel_id: number;
  title: string;
  content: PostBlock[];
  status: 'draft' | 'published';
  thumbnail?: string | null;
  series_id?: number | null;
  series_order?: number | null;
  tags?: string[];
  is_adult?: boolean;
  paywall_offset?: number | null;
  price_points?: number | null;
};

export type ChannelPostUpdateInput = Partial<Omit<ChannelPostCreateInput, 'channel_id'>>;

// ─── 댓글 ───────────────────────────────────────────────────────

export type ChannelPostComment = {
  id: number;
  post_id: number;
  parent_id: number | null;
  content: string | null;
  user: UserSummary;
  is_mine: boolean;
  /** soft delete 된 원댓글은 content=null + is_deleted=true (대댓글 보존) */
  is_deleted: boolean;
  reply_count: number;
  created_at: string | null;
};

// ─── 킬스위치 컨피그 (GET /v4/app-settings/creator-config) ──────

/** 전체 on/off 만 있는 플래그 */
export type CreatorFlag = { enabled: boolean };

/** 플랫폼(web/app)별로 분리된 플래그 — 스토어 심사 리스크 대응 */
export type CreatorPlatformFlag = CreatorFlag & { web: boolean; app: boolean };

/**
 * 포켓(크리에이터 채널) 플래그 — 2026-08-29 앱 전용 정책.
 * enabled 는 기능 마스터(이미 배포된 앱은 이 값만 읽는다 — 의미를 바꾸면 OTA 없이는 앱에 반영 불가),
 * web 은 웹 노출 분리 스위치로 **명시 true 일 때만** 웹에 노출한다(기본 = 웹 차단).
 * optional 인 이유: 기존 settings 행·기본값(`{enabled}`)과의 호환 — 서버는 항상 채워서 응답한다.
 */
export type CreatorChannelFlag = CreatorFlag & { web?: boolean };

export type CreatorConfig = {
  creator_channel: CreatorChannelFlag;
  adult_content: CreatorPlatformFlag;
  cash_charge: CreatorPlatformFlag;
  paid_posts: CreatorPlatformFlag;
  creator_payout: CreatorFlag;
};

/** creator-config 조회 실패 시에도 이 값으로 응답한다 — 안전 기본 전부 OFF */
export const DEFAULT_CREATOR_CONFIG: CreatorConfig = {
  creator_channel: { enabled: false },
  adult_content: { enabled: false, web: false, app: false },
  cash_charge: { enabled: false, web: false, app: false },
  paid_posts: { enabled: false, web: false, app: false },
  creator_payout: { enabled: false },
};

/** 요청 플랫폼 판별 헤더 값 (x-clack-platform) */
export type ClackPlatform = 'app' | 'web';
