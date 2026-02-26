# Contributing to @zenzap-co/sdk

## Keeping the SDK in sync with the API

The SDK should always reflect the latest Zenzap API.

**API docs:** https://docs.zenzap.co/api-reference/getting-started
**Full spec (LLM-friendly):** https://docs.zenzap.co/llms-full.txt

When the API changes or new endpoints are added:
1. Check `https://docs.zenzap.co/llms-full.txt` for the full current spec
2. Update `src/types.ts` with any new/changed types
3. Update `src/client.ts` with new methods
4. Note any discrepancies between docs and actual API behaviour in the comment block at the top of `client.ts`

## Known doc/API discrepancies

| Endpoint | Docs say | Actual API |
|----------|----------|------------|
| Send message body | `message` | `text` |
| Add/remove members body | `members` | `memberIds` |
| Get current member path | `/v2/members/current` | `/v2/members/me` |
