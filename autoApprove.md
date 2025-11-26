Implementation plan for the flexible approval system:

## Implementation plan: flexible approval system

### 1. Configuration storage

Option A: Per activity type (recommended)
- Add `autoApprove` boolean field to `activityTypes` table
- Default: `true` (current behavior)
- Allows different approval rules per activity type

Option B: Global setting
- Add to a `config` table or separate `appSettings` table
- Single setting for all activity types

Recommendation: Option A for flexibility.

### 2. Database changes

```sql
-- Add autoApprove column to activityTypes table
ALTER TABLE activityTypes 
ADD COLUMN autoApprove TINYINT(1) DEFAULT 1 AFTER isActive;
```

### 3. Upload flow changes (`mrController.js` - `uploadFile`)

Current flow (lines 501-658):
- Upload created → Points calculated → Status = "approved" → Points/dice rolls added immediately

New flow:
```
1. Check activityType.autoApprove setting
2. IF autoApprove = true:
   - Calculate points (keep existing logic)
   - Set status = "approved"
   - Add points/dice rolls immediately (existing code)
   - Set isCalculated = 1
3. IF autoApprove = false:
   - Calculate points (store but don't add yet)
   - Set status = "pending"
   - Set isCalculated = 0
   - Don't add points/dice rolls yet
```

### 4. Approval flow changes (`flmController.js` - `reviewUpload`)

Current behavior (lines 2434-2646):
- Only approves pending uploads (resubmissions)
- Adds points on approval

New behavior:
```
1. Check upload.status:
   - IF "pending" (first-time upload with manual approval):
     - Calculate and add points/dice rolls
     - Set status = "approved"
     - Set isCalculated = 1
   - IF "rejected" (resubmission):
     - Check attempts < maxAttempts (e.g., 1)
     - If allowed: Calculate and add points
     - Set status = "approved"
     - Set isCalculated = 1
     - Increment attempts
```

### 5. Rejection flow changes

Current behavior (lines 2657-2893):
- Rejects upload → Subtracts points if previously approved

New behavior:
```
1. IF status = "pending" (first-time, not yet approved):
   - Set status = "rejected"
   - Set rejectionReason
   - Set attempts = 1
   - Don't subtract points (none were added)
   - Allow resubmission (attempts = 1, max = 1 or 2)

2. IF status = "approved" (was auto-approved):
   - Subtract points (existing logic)
   - Set status = "rejected"
   - Set attempts = 1
   - Allow resubmission

3. IF status = "rejected" (resubmission):
   - Check attempts >= maxAttempts
   - If max reached: Block further resubmission
   - If not max: Set attempts = attempts + 1
```

### 6. Resubmission logic

Add validation in `uploadFile`:
```javascript
// Check if this is a resubmission
if (uploadId exists in rejected uploads for same MR + same type + same date):
  - Check attempts < maxAttempts (e.g., 1)
  - If attempts >= max: Reject upload with message "Maximum attempts reached"
  - If attempts < max: Allow resubmission
```

### 7. Points calculation refactoring

Extract points calculation into a reusable function:
```javascript
async function calculateAndAwardPoints(connection, uploadId, upload, activityType) {
  // Extract all the points calculation logic (lines 501-658)
  // This function can be called from:
  // 1. uploadFile (if autoApprove = true)
  // 2. reviewUpload (when approving)
}
```

### 8. Frontend changes

Upload page (`Upload.jsx`):
- Show status message based on `autoApprove`:
  - Auto-approve: "Upload successful! Points added."
  - Manual: "Upload submitted. Waiting for approval."

Actions page (FLM):
- Show pending uploads for manual approval
- Show rejection reason if rejected
- Show attempt count

### 9. API changes

Admin API:
- Add `autoApprove` field to `createActivityType` and `updateActivityType`
- Return `autoApprove` in activity type responses

FLM API:
- `reviewUpload` handles both first-time pending and resubmissions
- Return attempt count in responses

### 10. Edge cases

1. Changing `autoApprove` after uploads exist:
   - Existing uploads keep their status
   - New uploads follow the new setting

2. Attempt tracking:
   - Track attempts per upload (already in table)
   - Max attempts: configurable (default 1)

3. Points calculation timing:
   - Always calculate on upload (for display)
   - Only add points when approved

### 11. Implementation order

1. Database migration: add `autoApprove` column
2. Admin API: add `autoApprove` to CRUD
3. Upload flow: conditional approval logic
4. Approval flow: handle pending → approved
5. Rejection flow: handle attempts and resubmission
6. Resubmission validation: check attempts before allowing
7. Frontend: update UI for manual approval mode
8. Testing: test both flows

### 12. Configuration options

Consider making max attempts configurable:
```sql
ALTER TABLE activityTypes 
ADD COLUMN maxResubmissionAttempts INT DEFAULT 1 AFTER autoApprove;
```

This allows different activity types to have different resubmission limits.

---

## Summary

- Add `autoApprove` flag to activity types
- Conditionally approve on upload based on flag
- Move points addition to approval time when manual
- Track attempts and block resubmission after max
- Refactor points calculation into a reusable function
- Update frontend to show appropriate messages

Should I start with the database migration and the upload flow changes?




In <upload> API check isAutoApprovalAllowed flag, if it is true, the flow should work as is, if it false, then the prescription shouldn't be auto approved and points shouldn't be credited automatically, and the team leader should instead be able to approve the prescription at any later time


in <reviewPrescription> API, in case team lead is rejecting the prescription, it should only be allowed if the board that lead is playing on hasn't ended yet