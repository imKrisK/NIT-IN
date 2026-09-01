/**
 * ConversationMine subscription guard for NIT-IN (Express/Node.js).
 * Set CM_JWT_SECRET env var to the same value used on conversationmine-revenue.
 */
'use strict';

const jwt = require('jsonwebtoken');

const CM_JWT_SECRET = process.env.CM_JWT_SECRET || '';
const COM_DOMAIN = process.env.COM_DOMAIN || 'https://conversationmine.com';

function decodeCmToken(token) {
  try {
    return jwt.verify(token, CM_JWT_SECRET);
  } catch {
    return null;
  }
}

function getCmToken(req) {
  const cookie = req.cookies?.cm_token;
  if (cookie) return cookie;
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

/** Express middleware — gates routes to active CM subscribers. */
function requireCmSubscription(req, res, next) {
  const token = getCmToken(req);
  const payload = token ? decodeCmToken(token) : null;

  if (!payload || payload.subscription_status !== 'active') {
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json') || req.is('application/json')) {
      return res.status(401).json({
        error: 'subscription_required',
        login_url: `${COM_DOMAIN}/login`,
      });
    }
    const ssoTarget = encodeURIComponent(
      `${req.protocol}://${req.hostname}/auth/callback?return_to=${encodeURIComponent(req.originalUrl)}`
    );
    return res.redirect(`${COM_DOMAIN}/api/auth/sso?return_to=${ssoTarget}`);
  }

  req.cmUser = payload;
  next();
}

/**
 * Registers GET /auth/callback on an Express app.
 * Call once: registerAuthCallback(app);
 */
function registerAuthCallback(app) {
  app.get('/auth/callback', (req, res) => {
    const ssoToken = req.query.cm_sso || '';
    const returnTo = req.query.return_to || '/';

    if (!ssoToken) return res.redirect(`${COM_DOMAIN}/login`);

    let payload;
    try {
      payload = jwt.verify(ssoToken, CM_JWT_SECRET);
    } catch {
      return res.redirect(`${COM_DOMAIN}/login`);
    }

    if (payload.subscription_status !== 'active') {
      return res.redirect(`${COM_DOMAIN}/subscribe`);
    }

    const platformToken = jwt.sign(
      {
        user_id: payload.user_id,
        email: payload.email,
        plan: payload.plan,
        subscription_status: 'active',
      },
      CM_JWT_SECRET,
      { expiresIn: payload.plan === 'annual' ? '366d' : '31d' }
    );

    const maxAgeMs = (payload.plan === 'annual' ? 366 : 31) * 24 * 3600 * 1000;
    res
      .cookie('cm_token', platformToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: maxAgeMs,
        path: '/',
      })
      .redirect(returnTo);
  });
}

module.exports = { requireCmSubscription, registerAuthCallback };
