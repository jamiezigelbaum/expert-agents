# Private custody snapshots

`scripts/private-custody.ts` preserves live, unversioned expert workspaces
without putting owner content, filenames, paths, credentials, or memories in
Git or operator logs. It is the custody mechanism to run before retiring an
installation's workspaces; it is not a deployment or migration tool.

The script does not choose storage or key custody for the owner. No live
capture is authorized merely because the tooling exists.

## Security properties

- Snapshot archives stream directly from `tar` into recipient-based `age`
  encryption. No plaintext tar archive is written.
- The full manifest, including relative paths and per-file hashes, exists only
  inside the encrypted archive. The adjacent receipt is content-free: counts,
  byte totals, stable manifest hash, encrypted-artifact hash, normalized recipient-set
  hash, label, and storage identity only.
- A source is hashed before and after capture. A change during capture removes
  the partial artifact and fails the command.
- A two-copy capture requires distinct destination directories, storage IDs,
  and recipient files. Both copies must contain the same stable payload hash;
  otherwise both newly created copies are removed.
- Restore verification first checks the encrypted artifact hash, validates the
  archive member paths, decrypts into a mode-0700 temporary directory, and
  compares every restored file, directory, mode, symlink target hash, mtime,
  and content hash with the encrypted manifest.
- Restore uses capability-matched permission flags. GNU tar applies
  `--same-permissions --acls --xattrs`; bsdtar applies `-p`. The v1 receipt
  explicitly records that ACLs and extended attributes are preserved by tar
  but are not independently hashed by the portable manifest. Root and entry
  modes are independently attested.
- Git history is a separate encrypted bundle. Verification decrypts it only in
  a private temporary directory, performs an importable mirror clone, and runs
  `git fsck --full`.
- Subprocess diagnostics are never printed. Failures expose only a SHA-256
  diagnostic identifier. Source and identity paths are not written to
  receipts.
- Passphrase encryption is deliberately unsupported. The script fails unless
  explicit recipient and identity files are supplied.

The capture rejects special files, hard links, cross-filesystem trees,
ambiguous newline-containing paths, symlink roots, permissive destination or
restore directories, and overwrite attempts. The stable v1 manifest
independently attests portable filesystem content and modes.

## Key and storage decision required

Before capture, the owner must select:

1. Two genuinely independent private storage domains for the two copies of the
   unversioned primary workspace.
2. Two independent `age` recipient files. Their corresponding identity files
   should remain off the source host and be recoverable by the owner.
3. A private storage domain and recipient for the second workspace snapshot
   and its Git bundle. It may reuse one of the approved domains only if that is
   an explicit custody decision.
4. A restore-verification workstation or controlled verification window where
   each identity can be used without leaving the identity on the source host.

A recipient file contains public recipients only. A dedicated age identity or
an existing SSH public key is supported by `age`. Keep private identities out
of the repository, source workspace, shell history, receipts, and snapshot
destination.

The `--storage-id` value is a short, non-secret operator assertion such as
`offline-a` or `private-cloud-b`. The script enforces distinct IDs and paths,
but only the owner can establish that the underlying systems are physically
and administratively independent.

## Prerequisites

- Bun 1.3 or later
- `age`
- POSIX `tar` (`GNU tar` is used for the live Linux capture)
- Git for bundle creation and verification
- Existing absolute source paths
- Existing destination and restore-parent directories with mode `0700`
- Public recipient files for capture; private identity files with mode `0600`

Use task-specific shell variables. Never place a private identity in a
repository or source directory.

```sh
EA_CUSTODY_REPO=/absolute/path/to/Expert-Agents
EA_CUSTODY_PRIMARY_ROOT=/absolute/path/to/primary-workspace
EA_CUSTODY_SECONDARY_ROOT=/absolute/path/to/secondary-workspace
EA_CUSTODY_STORE_A=/absolute/private/storage-a
EA_CUSTODY_STORE_B=/absolute/private/storage-b
EA_CUSTODY_VERIFY_PARENT=/absolute/private/restore-tests
EA_CUSTODY_RECIPIENT_A=/absolute/public/recipient-a.txt
EA_CUSTODY_RECIPIENT_B=/absolute/public/recipient-b.txt
chmod 700 "$EA_CUSTODY_STORE_A" "$EA_CUSTODY_STORE_B" "$EA_CUSTODY_VERIFY_PARENT"
```

## Capture the independent primary pair

Run from the Expert Agents repository. The command emits only a compact,
content-free JSON result.

```sh
cd "$EA_CUSTODY_REPO"
bun scripts/private-custody.ts snapshot-pair \
  --source "$EA_CUSTODY_PRIMARY_ROOT" \
  --label primary-workspace \
  --destination-a "$EA_CUSTODY_STORE_A" \
  --recipient-file-a "$EA_CUSTODY_RECIPIENT_A" \
  --storage-id-a offline-a \
  --destination-b "$EA_CUSTODY_STORE_B" \
  --recipient-file-b "$EA_CUSTODY_RECIPIENT_B" \
  --storage-id-b private-cloud-b
```

Do not treat capture success as restore proof. Copy or synchronize each
encrypted archive and its adjacent receipt to its intended custody system,
then verify from that stored copy.

## Verify a snapshot restore

The default verification deletes the plaintext restore after hashing it. The
identity file must be private (`0600`). Replace the placeholders with the
archive and receipt emitted by capture.

```sh
EA_CUSTODY_IDENTITY_A=/absolute/private/identity-a.txt
chmod 600 "$EA_CUSTODY_IDENTITY_A"
cd "$EA_CUSTODY_REPO"
bun scripts/private-custody.ts verify-snapshot \
  --archive /absolute/private/storage-a/primary-workspace-a.TIMESTAMP.snapshot.tar.age \
  --receipt /absolute/private/storage-a/primary-workspace-a.TIMESTAMP.snapshot.tar.age.receipt.json \
  --identity-file "$EA_CUSTODY_IDENTITY_A" \
  --restore-parent "$EA_CUSTODY_VERIFY_PARENT"
```

Run the same test independently for copy B with identity B. Each pass creates a
content-free `*.verify.json` receipt beside the capture receipt. Use
`--keep-restored-at` only for an explicitly approved real restore; the target
must not exist and must be a direct child of the restore parent.

## Capture the secondary workspace and Git bundle

The encrypted workspace snapshot preserves tracked and untracked state. The
Git bundle preserves committed refs and is intentionally not a substitute for
the snapshot.

```sh
cd "$EA_CUSTODY_REPO"
bun scripts/private-custody.ts snapshot \
  --source "$EA_CUSTODY_SECONDARY_ROOT" \
  --destination "$EA_CUSTODY_STORE_A" \
  --recipient-file "$EA_CUSTODY_RECIPIENT_A" \
  --label secondary-workspace \
  --storage-id offline-a

bun scripts/private-custody.ts git-bundle \
  --source "$EA_CUSTODY_SECONDARY_ROOT" \
  --destination "$EA_CUSTODY_STORE_A" \
  --recipient-file "$EA_CUSTODY_RECIPIENT_A" \
  --label secondary-workspace \
  --storage-id offline-a
```

Verify the snapshot as above, then prove that the bundle can be imported and
that every Git object is intact:

```sh
bun scripts/private-custody.ts verify-git-bundle \
  --archive /absolute/private/storage-a/secondary-workspace.TIMESTAMP.git.bundle.age \
  --receipt /absolute/private/storage-a/secondary-workspace.TIMESTAMP.git.bundle.age.receipt.json \
  --identity-file "$EA_CUSTODY_IDENTITY_A" \
  --restore-parent "$EA_CUSTODY_VERIFY_PARENT"
```

## Completion evidence

The state-custody gate closes only when all of the following are preserved
outside the source host and reviewed:

- two primary encrypted archives with matching payload-manifest hashes,
  distinct storage IDs, and disjoint recipient sets;
- one passing restore-verification receipt for each primary copy;
- one encrypted secondary workspace archive and passing restore receipt;
- one encrypted secondary Git bundle and passing clone/fsck receipt;
- a recorded Git HEAD matching the expected source anchor;
- confirmation that no private identity was left on the source host;
- separate sanitized mapping/config parity evidence for managed cloud state,
  agent registration, messaging bindings, and runtime audit state.

Only after those artifacts and the installation's own retirement checks pass
may any old implementation, workspace, service, mapping, or source binding be
retired.
