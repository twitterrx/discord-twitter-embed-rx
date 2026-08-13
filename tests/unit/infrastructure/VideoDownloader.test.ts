import { EventEmitter } from "node:events";
import type { IncomingMessage, ClientRequest } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaUrl } from "../../fixtures/testMediaUrl.js";

vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(),
}));
vi.mock("node:https", () => ({ get: vi.fn() }));
vi.mock("node:http", () => ({ get: vi.fn() }));

// モック後にインポート
import { createWriteStream, type WriteStream } from "node:fs";
import * as httpsModule from "node:https";
import * as httpModule from "node:http";
import { VideoDownloader } from "#/infrastructure/http/VideoDownloader.js";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** 書き込みストリームのモックを生成 */
const createMockWriteStream = () => {
  const stream = Object.assign(new EventEmitter() as EventEmitter, {
    close: vi.fn().mockReturnThis(),
  }) as unknown as WriteStream;
  return stream;
};

/** HTTP レスポンスのモックを生成 */
const createMockResponse = (statusCode: number) => {
  const response = Object.assign(new EventEmitter() as EventEmitter, {
    statusCode,
    resume: vi.fn(),
    pipe: vi.fn(),
  }) as unknown as IncomingMessage;
  return response;
};

/** http.get / https.get のモック実装をセットアップ */
const setupHttpGetMock = (
  mockResponse: IncomingMessage,
  mockRequest?: EventEmitter,
) => {
  const req = mockRequest ?? new EventEmitter();
  (vi.mocked(httpModule.get) as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_url: unknown, _optionsOrCb: unknown, maybeCb?: unknown) => {
      const callback = maybeCb ?? _optionsOrCb;
      if (typeof callback === "function") {
        callback(mockResponse);
      }
      return req;
    },
  );
  return req as unknown as ClientRequest;
};

describe("VideoDownloader", () => {
  let downloader: VideoDownloader;

  beforeEach(() => {
    downloader = new VideoDownloader();
    vi.clearAllMocks();
  });

  describe("download", () => {
    it("URL をダウンロードできる", async () => {
      const mockWriteStream = createMockWriteStream();
      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const mockResponse = createMockResponse(200);
      mockResponse.pipe = vi.fn().mockImplementation(() => {
        process.nextTick(() => mockWriteStream.emit("finish"));
      });

      setupHttpGetMock(mockResponse);

      await expect(
        downloader.download(mediaUrl("video.mp4"), "/tmp/test.mp4"),
      ).resolves.toBeUndefined();

      expect(createWriteStream).toHaveBeenCalledWith("/tmp/test.mp4");
      expect(mockResponse.pipe).toHaveBeenCalledWith(mockWriteStream);
      expect(mockWriteStream.close).toHaveBeenCalled();
    });

    it("HTTP URL をダウンロードできる", async () => {
      const mockWriteStream = createMockWriteStream();
      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const mockResponse = createMockResponse(200);
      mockResponse.pipe = vi.fn().mockImplementation(() => {
        process.nextTick(() => mockWriteStream.emit("finish"));
      });

      setupHttpGetMock(mockResponse);

      await expect(
        downloader.download(mediaUrl("video.mp4"), "/tmp/test.mp4"),
      ).resolves.toBeUndefined();

      expect(httpModule.get).toHaveBeenCalled();
      expect(httpsModule.get).not.toHaveBeenCalled();
    });

    it("HTTP 200 以外のレスポンス（例: 404）は reject する", async () => {
      const mockResponse = createMockResponse(404);

      setupHttpGetMock(mockResponse);

      await expect(
        downloader.download(mediaUrl("video.mp4"), "/tmp/test.mp4"),
      ).rejects.toThrow("Failed to download file: 404");

      expect(mockResponse.resume).toHaveBeenCalled();
    });

    it("リクエストエラーが発生した場合 reject する", async () => {
      const mockRequest = new EventEmitter();
      (vi.mocked(httpModule.get) as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () => mockRequest,
      );

      const downloadPromise = downloader.download(
        mediaUrl("video.mp4"),
        "/tmp/test.mp4",
      );
      mockRequest.emit("error", new Error("connection refused"));

      await expect(downloadPromise).rejects.toThrow("connection refused");
    });

    it("書き込みストリームでエラーが発生した場合 reject する", async () => {
      const mockWriteStream = createMockWriteStream();
      vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

      const mockResponse = createMockResponse(200);
      mockResponse.pipe = vi.fn().mockImplementation(() => {
        process.nextTick(() =>
          mockWriteStream.emit("error", new Error("disk full")),
        );
      });

      setupHttpGetMock(mockResponse);

      await expect(
        downloader.download(mediaUrl("video.mp4"), "/tmp/test.mp4"),
      ).rejects.toThrow("disk full");

      expect(mockWriteStream.close).toHaveBeenCalled();
    });
  });
});
