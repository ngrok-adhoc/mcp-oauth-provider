import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface S3Storage {
  bucket: string;
  key: string;
  owner?: string;
  required: boolean;
  region?: string;
  profile?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

interface StateStorage {
  remote?: boolean;
  read(): string | undefined | Promise<string | undefined>;
  write(data: string): void | Promise<void>;
  close(): void;
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function readHolder(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "";
    throw error;
  }
}

function pidNamespace() {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

export async function openStateStorage(cwd: string, s3?: S3Storage): Promise<StateStorage> {
  return (s3 && (await openS3(s3))) || openFileStorage(cwd);
}

function openFileStorage(cwd: string): StateStorage {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error(
      "Local OAuth storage requires a POSIX filesystem. Use Docker or S3 on Windows.",
    );
  const directory = join(cwd, ".mcp-oauth-provider");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const folder = lstatSync(directory);
  if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0)
    throw new Error(
      `OAuth state directory must be owned by the current user and private (0700): ${directory}`,
    );
  try {
    writeFileSync(join(directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const filename = join(directory, "oauth.json");
  const pending = join(directory, ".oauth.json.tmp");
  const lock = join(directory, ".lock");
  const holder = join(lock, "holder");
  // PIDs are only comparable inside one PID namespace, so containers sharing a hostname never match.
  const host = `${hostname()}/${pidNamespace()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(holder, `${host} ${process.pid}`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      // A lock left by a process that has exited on this machine is stale.
      // shortcut: two providers starting at once after a crash can both clear the same stale lock; run one at a time.
      const [holderHost, id] = readHolder(holder).split(" ");
      const pid = Number(id);
      const stale = holderHost === host && pid > 0 && Number.isSafeInteger(pid) && !running(pid);
      if (attempt || !stale)
        throw new Error(
          `OAuth state is already locked at ${lock}. Confirm the prior provider has stopped before removing the lock directory.`,
        );
      rmSync(lock, { recursive: true });
    }
  }

  return {
    read() {
      try {
        unlinkSync(pending);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      const privateFileError = () =>
        new Error(
          `OAuth state file must be owned by the current user and private (0600): ${filename}`,
        );
      let fd;
      try {
        fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return;
        if (hasCode(error, "ELOOP")) throw privateFileError();
        throw error;
      }
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o077) !== 0)
          throw privateFileError();
        return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    },
    write(data) {
      writeFileSync(pending, data, { flag: "wx", mode: 0o600, flush: true });
      renameSync(pending, filename);
      const dir = openSync(directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    },
    close() {
      rmSync(lock, { recursive: true });
    },
  };
}

async function openS3({
  bucket,
  key,
  owner,
  required,
  region,
  profile,
  credentials,
}: S3Storage): Promise<StateStorage | undefined> {
  const { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({ region, profile, credentials, maxAttempts: 2 });
  try {
    await client.config.credentials();
  } catch (error) {
    client.destroy();
    if (!required && error instanceof Error && error.name === "CredentialsProviderError") return;
    throw new Error("Cannot resolve AWS credentials for OAuth state.", { cause: error });
  }
  // Pins the bucket's AWS account so a mistyped or reclaimed name can't receive the signing key.
  const object = { Bucket: bucket, Key: key, ExpectedBucketOwner: owner };
  let etag: string | undefined;
  return {
    remote: true,
    async read() {
      try {
        const response = await client.send(new GetObjectCommand(object), {
          abortSignal: AbortSignal.timeout(15000),
        });
        if (!response.Body || !response.ETag)
          throw new Error("S3 returned state without a body or ETag.");
        etag = response.ETag;
        return await response.Body.transformToString();
      } catch (error) {
        if (error instanceof NoSuchKey) return;
        throw new Error(`Cannot read OAuth state from s3://${bucket}/${key}.`, { cause: error });
      }
    },
    async write(data) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            ...object,
            Body: data,
            ContentType: "application/json",
            ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
          }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
        if (!response.ETag) throw new Error("S3 did not return an ETag for the saved snapshot.");
        etag = response.ETag;
      } catch (error) {
        if (
          error instanceof Error &&
          ["PreconditionFailed", "ConditionalRequestConflict"].includes(error.name)
        )
          throw new Error("OAuth state changed in S3. Stop the competing instance and restart.", {
            cause: error,
          });
        throw new Error(`Cannot save OAuth state to s3://${bucket}/${key}.`, { cause: error });
      }
    },
    close() {
      client.destroy();
    },
  };
}
