import { describe, expect, it } from 'vitest';
import { rpIdMatchesHost } from '@/background/passkey-vault';

describe('rpIdMatchesHost (INFRA-585)', () => {
  it('offers a passkey to its host and to its subdomains only', () => {
    expect(rpIdMatchesHost('shopify.com', 'shopify.com')).toBe(true);
    expect(rpIdMatchesHost('shopify.com', 'accounts.shopify.com')).toBe(true);
    expect(rpIdMatchesHost('shopify.com', 'evilshopify.com')).toBe(false);
    expect(rpIdMatchesHost('accounts.shopify.com', 'shopify.com')).toBe(false);
    expect(rpIdMatchesHost('shopify.com', 'shopify.com.evil.net')).toBe(false);
  });
});
