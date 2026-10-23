export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  try {
    const mod = await import('./_bundle.cjs');
    const handleRequest = mod.handleRequest ?? mod.default?.handleRequest;
    await handleRequest(req, res);
  } catch (err) {
    console.error('Serverless handler error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: {
            code: 'SERVER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }
}
