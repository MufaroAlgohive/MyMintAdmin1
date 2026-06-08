# Mint Platform — Client Error Reporting Integration

Add this snippet to the Mint client-facing app (mint-development / app.mymint.co.za) to automatically report high-severity errors to the CRM's Cyber Compliance Centre.

## Where to add it

Create a new utility file: `src/lib/reportError.ts` (or `.js`)

## The code

```typescript
// src/lib/reportError.ts
// Reports critical client-side errors to the Mint CRM monitoring system.
// Safe to call from anywhere — fails silently if the CRM is unreachable.

const CRM_ERROR_ENDPOINT = 'https://my-mint-admin.vercel.app/api/monitor/client-error';

type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

interface ClientErrorPayload {
  title: string;
  description?: string;
  severity?: ErrorSeverity;
  category?: 'auth' | 'kyc' | 'trade' | 'wallet' | 'ui' | 'network' | 'other';
  user_id?: string | null;
  page?: string;
  error_stack?: string;
  extra?: Record<string, unknown>;
}

export const reportError = async (payload: ClientErrorPayload): Promise<void> => {
  try {
    await fetch(CRM_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        page:      payload.page      ?? (typeof window !== 'undefined' ? window.location.pathname : 'unknown'),
        reported_at: new Date().toISOString(),
        source:    'mint-platform'
      })
    });
  } catch {
    // Fail silently — never block the user for monitoring
  }
};
```

## Usage examples

```typescript
import { reportError } from '@/lib/reportError';

// Auth failure
reportError({
  title:       'Login failed',
  description: 'User could not sign in — Supabase returned 400',
  severity:    'high',
  category:    'auth',
  user_id:     null
});

// KYC submission error
reportError({
  title:       'KYC submission error',
  description: error.message,
  severity:    'high',
  category:    'kyc',
  user_id:     session?.user?.id
});

// Trade execution failure
reportError({
  title:       'Trade failed: buy order rejected',
  description: `Strategy ${strategyId} — ${error.message}`,
  severity:    'critical',
  category:    'trade',
  user_id:     session?.user?.id,
  extra:       { strategy_id: strategyId, amount }
});

// Wallet top-up failure
reportError({
  title:       'EFT wallet top-up failed',
  description: error.message,
  severity:    'high',
  category:    'wallet',
  user_id:     session?.user?.id
});
```

## Global error boundary (React)

```typescript
// In your root ErrorBoundary component:
componentDidCatch(error: Error, info: ErrorInfo) {
  reportError({
    title:       `Unhandled React error: ${error.message}`,
    description: info.componentStack ?? undefined,
    severity:    'critical',
    category:    'ui',
    error_stack: error.stack
  });
}
```

## Notes
- Only `high` and `critical` severity errors create automatic incidents in the CRM
- `low` and `medium` errors are logged but don't trigger alerts
- The endpoint requires no authentication (it's designed for public client-side reporting)
- Rate limiting is applied per IP (max 30 requests per minute)
- The CRM is at `https://my-mint-admin.vercel.app` on Vercel deployment
