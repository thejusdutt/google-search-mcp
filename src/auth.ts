import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Health check bearer token from environment
const HEALTH_CHECK_TOKEN = process.env.HEALTH_CHECK_TOKEN;

// JWKS client for JWT validation
const client = jwksClient({
  jwksUri: 'https://idp.devops.tui/keys',
  cache: true,
  cacheMaxAge: 600000, // 10 minutes
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export interface UserInfo {
  email: string;
  name?: string;
  sub?: string;
}

export interface AuthResult {
  type: 'health-check' | 'user';
  user?: UserInfo;
}

/**
 * Validates bearer token for health checks
 */
function validateBearerToken(token: string): boolean {
  if (!HEALTH_CHECK_TOKEN) {
    return false;
  }
  return token === HEALTH_CHECK_TOKEN;
}

/**
 * Validates JWT token from TUI IdP
 */
function validateJwtToken(token: string): Promise<UserInfo> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded: any) => {
      if (err) {
        reject(new Error(`JWT validation failed: ${err.message}`));
        return;
      }

      if (!decoded || typeof decoded !== 'object') {
        reject(new Error('Invalid token payload'));
        return;
      }

      resolve({
        email: decoded.email,
        name: decoded.name,
        sub: decoded.sub,
      });
    });
  });
}

/**
 * Authenticates incoming request
 * Supports both health check bearer tokens and user JWT tokens
 */
export async function authenticate(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader) {
    throw new Error('No authorization header provided');
  }

  // Extract token
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (!token) {
    throw new Error('Invalid authorization header format');
  }

  // Check if it's a health check token
  if (validateBearerToken(token)) {
    return { type: 'health-check' };
  }

  // Otherwise validate as JWT
  try {
    const user = await validateJwtToken(token);
    return { type: 'user', user };
  } catch (error) {
    throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Checks if authentication is enabled
 */
export function isAuthEnabled(): boolean {
  // Auth is enabled if we're in hosted mode (HOSTED_MODE=true)
  // or if HEALTH_CHECK_TOKEN is set
  return process.env.HOSTED_MODE === 'true' || !!HEALTH_CHECK_TOKEN;
}
