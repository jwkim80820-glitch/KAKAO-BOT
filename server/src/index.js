// 로컬 실행용 (npm start). Vercel에서는 api/index.js가 같은 앱을 서버리스 함수로 띄운다.
import { createServerApp } from './services.js';

const app = createServerApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
