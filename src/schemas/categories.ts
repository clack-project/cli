// 앱의 CATEGORIES.ts와 같은 저장용 한국어 카테고리다.
export const PRODUCT_CATEGORY_GROUPS = [
  {
    name: '랜덤박스',
    children: [{ name: '랜덤박스' }],
  },
  {
    name: '공동 구매',
    children: [{ name: '공동 구매' }],
  },
  {
    name: '아크릴',
    children: [
      { name: '아크릴뱃지/캔뱃지' },
      { name: '아크릴 스탠드' },
      { name: '디오라마' },
      { name: '아크릴 블록' },
      { name: '아크릴 코롯토' },
      { name: '기타' },
    ],
  },
  {
    name: '인형',
    children: [
      { name: '손가락 인형' },
      { name: '후와' },
      { name: '만쥬' },
      { name: '모찌마스' },
      { name: '누이인형' },
      { name: '테레코레' },
      { name: '기타' },
    ],
  },
  {
    name: '피규어',
    children: [
      { name: '피규어' },
      { name: '넨도로이드' },
      { name: '팔버스 피규어' },
      { name: '힛카케' },
      { name: '기타' },
    ],
  },
  {
    name: '지류',
    children: [{ name: '만화책' }, { name: '명함' }, { name: '포스터' }, { name: '기타' }],
  },
  {
    name: '기타',
    children: [
      { name: '향수' },
      { name: '이타백' },
      { name: '로제트' },
      { name: '타올' },
      { name: '파일' },
      { name: '기타' },
    ],
  },
  {
    name: '키링',
    children: [{ name: '키링' }, { name: '오마모리' }, { name: '기타' }],
  },
  {
    name: '포토카드',
    children: [{ name: '포토카드' }, { name: '파샤코레' }, { name: '기타' }],
  },
  {
    name: '의류',
    children: [{ name: '일반 옷' }, { name: '코스프레 옷' }],
  },
  {
    name: '커미션',
    children: [{ name: '커미션' }],
  },
  {
    name: '아이돌',
    children: [
      { name: '음반/영상' },
      { name: '포토카드' },
      { name: '포스터/화보' },
      { name: '피규어' },
      { name: '응원도구' },
      { name: '기타' },
    ],
  },
];

export const PRODUCT_CATEGORIES = PRODUCT_CATEGORY_GROUPS.flatMap((group) => group.children.map((child) => `${group.name} > ${child.name}`));
