// 초급자용 판정 레이어. CLI JSON(schemaVersion 2)을 읽어 "무엇을 먼저 고칠지"로 바꾼다.
// 여기서 새로운 탐지를 하지 않는다. 이미 나온 결과의 심각도·설명만 다시 매긴다.

const RULES = {
  'write-no-auth': {
    level: 'S1',
    title: '로그인 확인 없이 데이터를 바꿀 수 있는 API',
    plain:
      '이 주소로는 로그인하지 않은 사람도 데이터를 만들거나 고치거나 지울 수 있습니다.',
    why:
      'POST·PATCH·DELETE를 인증 없이 받고 있다는 뜻입니다. 배포되면 주소만 아는 사람이 ' +
      '남의 글을 지우거나, 설정을 바꾸거나, 원치 않는 데이터를 넣을 수 있습니다. ' +
      '인증 확인이 없다는 건 사실상 "누구나 이 작업을 할 수 있다"와 같습니다.',
    steps: [
      {
        do: 'middleware.ts에서 이 경로를 먼저 막으세요. 가장 적은 수정으로 전체를 덮습니다.',
        file: 'middleware.ts',
        code:
          "import { NextResponse } from 'next/server'\n" +
          "import type { NextRequest } from 'next/server'\n\n" +
          'export function middleware(req: NextRequest) {\n' +
          "  if (!req.cookies.get('session')) {\n" +
          "    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })\n" +
          '  }\n' +
          '  return NextResponse.next()\n' +
          '}\n\n' +
          "export const config = { matcher: ['/api/config/:path*'] }",
      },
      {
        do: '미들웨어를 쓰기 어려운 구조라면 라우트 함수 안에서 직접 확인하세요.',
        file: 'app/api/.../route.ts',
        code:
          'const session = await auth()\n' +
          "if (!session) return new Response('unauthorized', { status: 401 })",
      },
      {
        do: '일부러 공개한 API라면 코드에 "공개 API" 주석을 남기고, 왜 공개인지 적어두세요. 나중에 실수와 구분됩니다.',
      },
    ],
    check: '다시 검사해서 이 주소가 "로그인 확인 없음" 목록에서 사라졌는지 보세요.',
  },
  'read-no-auth': {
    level: 'S2',
    title: '로그인 없이 읽히는 API',
    plain: '누구나 이 주소로 데이터를 읽을 수 있습니다.',
    why:
      '읽기만 하는 API는 위험이 작지만, 안에 개인정보나 내부 정보가 있으면 그대로 노출됩니다. ' +
      '일부러 공개한 것인지 아닌지가 핵심입니다.',
    steps: [
      {
        do: '응답에 남의 정보나 내부 값이 들어가는지 확인하세요. 들어간다면 인증을 추가합니다.',
        file: 'app/api/.../route.ts',
        code:
          'const session = await auth()\n' +
          "if (!session) return new Response('unauthorized', { status: 401 })",
      },
      {
        do: '공개해도 되는 데이터라면 그대로 두세요. 다만 캐시와 요청 제한(rate limit)을 두는 편이 안전합니다.',
      },
    ],
    check: '다시 검사했을 때 이 주소가 의도한 상태인지 확인하세요.',
  },
  secret: {
    level: 'S1',
    title: '비밀키가 코드나 저장소에 들어 있음',
    plain: 'API 키나 비밀번호가 파일에 그대로 적혀 있습니다.',
    why:
      '저장소를 공개하거나 협업자에게 공유하는 순간 키가 그대로 노출됩니다. ' +
      '이미 커밋된 키는 지워도 Git 기록에 남습니다.',
    steps: [
      {
        do: '키를 .env.local로 옮기고 코드에서는 process.env로 읽으세요.',
        file: '.env.local',
        code: "OPENAI_API_KEY=sk-...\n\n// 코드에서\nconst key = process.env.OPENAI_API_KEY",
      },
      {
        do: '이미 노출된 키는 반드시 재발급하세요. 파일에서 지우는 것만으로는 부족합니다.',
      },
      {
        do: '.env.local이 .gitignore에 들어 있는지 확인하세요.',
        file: '.gitignore',
        code: '.env\n.env.local\n.env*.local',
      },
    ],
    check: '다시 검사해서 비밀키 항목이 사라졌는지 확인하세요.',
  },
  'env-tracked': {
    level: 'S1',
    title: '.env 파일이 git에 올라가 있음',
    plain: '비밀값이 담긴 파일이 저장소에 포함되어 있습니다.',
    why:
      '한 번 커밋되면 과거 기록에 계속 남습니다. 저장소를 공개하는 순간 과거 커밋까지 함께 노출됩니다.',
    steps: [
      {
        do: '.gitignore에 추가하고 추적을 해제하세요. 파일 자체는 남습니다.',
        code: 'echo ".env" >> .gitignore\ngit rm --cached .env\ngit commit -m "chore: stop tracking .env"',
      },
      {
        do: '들어 있던 키는 전부 재발급하세요. 기록에 남아 있으므로 폐기해야 합니다.',
      },
    ],
    check: 'git status에 .env가 더 이상 뜨지 않는지 확인하세요.',
  },
  'page-error': {
    level: 'S2',
    title: '페이지가 열리지 않음',
    plain: '이 페이지를 열면 오류가 납니다.',
    why:
      '방문자는 흰 화면이나 오류 문구를 보게 됩니다. 배포 후에 발견하면 첫인상을 잃습니다.',
    steps: [
      {
        do: '개발 서버를 켜고 그 주소를 직접 열어 오류 내용을 확인하세요.',
        code: 'npm run dev\n# 브라우저에서 해당 경로 열기',
      },
      {
        do: '서버 컴포넌트에서 예외가 나는 경우가 많습니다. 데이터가 없을 때의 처리를 추가하세요.',
        file: 'app/.../error.tsx',
        code: "'use client'\n\nexport default function Error({ reset }: { reset: () => void }) {\n  return (\n    <div>\n      <p>문제가 발생했습니다.</p>\n      <button onClick={reset}>다시 시도</button>\n    </div>\n  )\n}",
      },
    ],
    check: '다시 검사해서 페이지 오류가 사라졌는지 확인하세요.',
  },
  weight: {
    level: 'S3',
    title: '페이지 용량이 기준보다 큼',
    plain: '이 페이지를 처음 여는 데 시간이 오래 걸립니다.',
    why:
      '자바스크립트가 크면 휴대폰과 느린 인터넷에서 흰 화면이 오래 유지됩니다. ' +
      '검색 순위에도 불리합니다.',
    steps: [
      {
        do: '무엇이 큰지 먼저 확인하세요. 추측보다 측정이 빠릅니다.',
        code: 'npm i -D @next/bundle-analyzer\nANALYZE=true npm run build',
      },
      {
        do: '무거운 라이브러리는 화면에 필요할 때만 불러오세요.',
        file: 'app/.../page.tsx',
        code: "import dynamic from 'next/dynamic'\n\nconst Chart = dynamic(() => import('@/components/Chart'), { ssr: false })",
      },
      {
        do: '아이콘·날짜 라이브러리는 전체를 import하지 말고 쓰는 것만 가져오세요.',
        code: "// 나쁨\nimport _ from 'lodash'\n\n// 좋음\nimport debounce from 'lodash/debounce'",
      },
    ],
    check: '다시 빌드해서 First Load JS 숫자가 줄었는지 비교하세요.',
  },
  artifacts: {
    level: 'S2',
    title: '배포물에 내부 정보가 남아 있음',
    plain: '빌드 결과물에 소스맵이나 내부 파일이 그대로 들어 있습니다.',
    why:
      '소스맵은 원본 코드를 그대로 복원할 수 있게 합니다. 실수로 넣은 내부 주소나 주석까지 함께 나갑니다.',
    steps: [
      {
        do: '프로덕션 소스맵 생성을 끄세요.',
        file: 'next.config.js',
        code: 'module.exports = {\n  productionBrowserSourceMaps: false,\n}',
      },
      {
        do: '다시 빌드한 뒤 배포물을 검사해 남은 파일이 없는지 확인하세요.',
        code: 'npm run build',
      },
    ],
    check: '꼼꼼에서 "배포물 검사"를 다시 실행하세요.',
  },
};

const UNKNOWN_REASONS = new Set(['sample-missing', 'fast', 'source-scan']);

function levelOf(item) {
  const id = String(item.id || '');
  const base = id.split(':')[0];
  if (RULES[base]) return RULES[base].level;
  return item.severity === 'error' ? 'S1' : item.severity === 'warning' ? 'S2' : 'S3';
}

function ruleOf(item) {
  const base = String(item.id || '').split(':')[0];
  return RULES[base] || null;
}

function describe(item) {
  const rule = ruleOf(item);
  const path = String(item.id || '').split(':')[1] || '';
  return {
    level: levelOf(item),
    path,
    title: rule?.title || '확인이 필요한 항목',
    plain: rule?.plain || item.message || '',
    why: rule?.why || item.message || '이 항목은 자동으로 판정하지 못했습니다. 직접 확인해 주세요.',
    steps: rule?.steps || [
      { do: '해당 파일을 열어 실제 동작을 확인하세요.', file: path || undefined },
    ],
    check: rule?.check || '수정한 뒤 다시 검사하세요.',
    raw: item.message || '',
  };
}

export function analyze(json, meta = {}) {
  const findings = (json.extra || []).map(describe);
  const routes = json.diff?.routes || [];
  const checks = json.coverage?.checks || [];

  const s1 = findings.filter((f) => f.level === 'S1');
  const s2 = findings.filter((f) => f.level === 'S2');
  const s3 = findings.filter((f) => f.level === 'S3');

  const unknownRoutes = routes.filter((r) => r.auth === 'unknown' || r.to === 'unknown');
  const skipped = checks.filter((c) => c.status === 'skipped' && UNKNOWN_REASONS.has(c.reason));
  const failed = checks.filter((c) => c.status === 'failed');
  const incomplete = json.coverage?.status === 'incomplete';

  let verdict;
  if (s1.length) {
    verdict = {
      level: 'danger',
      badge: '지금 배포하면 안 됩니다',
      title: `먼저 고칠 것 ${s1.length}개`,
      body: '이대로 올리면 다른 사람이 데이터를 바꾸거나 비밀값이 노출될 수 있습니다.',
    };
  } else if (s2.length) {
    verdict = {
      level: 'warn',
      badge: '고치고 배포하세요',
      title: `확인할 것 ${s2.length}개`,
      body: '치명적이진 않지만 그대로 두면 사용자가 불편을 겪습니다.',
    };
  } else if (failed.length || unknownRoutes.length) {
    verdict = {
      level: 'warn',
      badge: '확인하지 못한 항목이 있습니다',
      title: '문제는 발견되지 않았지만 전부 확인하진 못했습니다',
      body: '아래 "확인 못 한 것"을 보고 직접 한 번 열어보세요.',
    };
  } else {
    verdict = {
      level: 'ok',
      badge: '배포해도 됩니다',
      title: '막는 문제가 없습니다',
      body: '검사한 범위 안에서는 문제가 발견되지 않았습니다.',
    };
  }

  const next = (() => {
    const groups = new Map();
    for (const f of [...s1, ...s2, ...s3]) {
      const g = groups.get(f.title);
      if (!g) {
        groups.set(f.title, { ...f, count: 1, paths: f.path ? [f.path] : [] });
      } else {
        g.count += 1;
        if (f.path && !g.paths.includes(f.path)) g.paths.push(f.path);
      }
    }
    return [...groups.values()].slice(0, 3).map((g) => ({
      title: g.title,
      level: g.level,
      where: g.count > 1 ? `${g.paths[0]} 외 ${g.count - 1}곳` : g.paths[0] || '',
      paths: g.paths.slice(0, 8),
      count: g.count,
      plain: g.plain,
      why: g.why,
      steps: g.steps,
      check: g.check,
    }));
  })();

  return {
    verdict,
    findings,
    next,
    unknown: {
      routes: unknownRoutes.map((r) => r.path),
      skipped: skipped.map((c) => `${c.rule} ${c.path}${c.method ? ' ' + c.method : ''}`),
      incomplete,
      buildFailed: Boolean(json.buildFailed),
    },
    counts: { s1: s1.length, s2: s2.length, s3: s3.length, total: findings.length },
    meta,
  };
}
