import { logger } from '../utils/logger';
import type {
  LoaderCallbacks,
  LoaderContext,
  LoaderStats,
  Loader,
  LoaderConfiguration,
  LoaderResponse,
} from '../types/loader';
import { LoadStats } from '../loader/load-stats';
import { RetryConfig } from '../config';
import { getRetryDelay, shouldRetry } from './error-helper';

const AGE_HEADER_LINE_REGEX = /^age:\s*[\d.]+\s*$/im;

class XhrLoader implements Loader<LoaderContext> {
  private xhrSetup: Function | null;
  private requestTimeout?: number;
  private retryTimeout?: number;
  private retryDelay: number;
  private config: LoaderConfiguration | null = null;
  private callbacks: LoaderCallbacks<LoaderContext> | null = null;
  public context!: LoaderContext;

  private loader: XMLHttpRequest | null = null;
  public stats: LoaderStats;

  constructor(config /* HlsConfig */) {
    this.xhrSetup = config ? config.xhrSetup : null;
    this.stats = new LoadStats();
    this.retryDelay = 0;
  }

  destroy(): void {
    this.callbacks = null;
    this.abortInternal();
    this.loader = null;
    this.config = null;
  }

  abortInternal(): void {
    const loader = this.loader;
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    if (loader) {
      loader.onreadystatechange = null;
      loader.onprogress = null;
      if (loader.readyState !== 4) {
        this.stats.aborted = true;
        loader.abort();
      }
    }
  }

  abort(): void {
    this.abortInternal();
    if (this.callbacks?.onAbort) {
      this.callbacks.onAbort(this.stats, this.context, this.loader);
    }
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>
  ): void {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    this.stats.loading.start = self.performance.now();
    this.context = context;
    this.config = config;
    this.callbacks = callbacks;
    this.loadInternal();
  }

  loadInternal(): void {
    const { config, context } = this;
    if (!config) {
      return;
    }
    const xhr = (this.loader = new self.XMLHttpRequest());

    const stats = this.stats;
    stats.loading.first = 0;
    stats.loaded = 0;
    const xhrSetup = this.xhrSetup;

    try {
      if (xhrSetup) {
        try {
          xhrSetup(xhr, context.url);
        } catch (e) {
          // fix xhrSetup: (xhr, url) => {xhr.setRequestHeader("Content-Language", "test");}
          // not working, as xhr.setRequestHeader expects xhr.readyState === OPEN
          xhr.open('GET', context.url, true);
          xhrSetup(xhr, context.url);
        }
      }
      if (!xhr.readyState) {
        xhr.open('GET', context.url, true);
      }

      const headers = this.context.headers;
      if (headers) {
        for (const header in headers) {
          xhr.setRequestHeader(header, headers[header]);
        }
      }
    } catch (e) {
      // IE11 throws an exception on xhr.open if attempting to access an HTTP resource over HTTPS
      this.callbacks!.onError(
        { code: xhr.status, text: e.message },
        context,
        xhr,
        stats
      );
      return;
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader(
        'Range',
        'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1)
      );
    }

    xhr.onreadystatechange = this.readystatechange.bind(this);
    xhr.onprogress = this.loadprogress.bind(this);
    xhr.responseType = context.responseType as XMLHttpRequestResponseType;
    // setup timeout before we perform request
    self.clearTimeout(this.requestTimeout);
    config.timeout = config.loadPolicy.maxTimeToFirstByteMs;
    this.requestTimeout = self.setTimeout(
      this.loadtimeout.bind(this),
      config.loadPolicy.maxTimeToFirstByteMs
    );
    xhr.send();
  }

  readystatechange(): void {
    const { context, loader: xhr, stats } = this;
    if (!context || !xhr) {
      return;
    }
    const readyState = xhr.readyState;
    const config = this.config as LoaderConfiguration;

    // don't proceed if xhr has been aborted
    if (stats.aborted) {
      return;
    }

    // >= HEADERS_RECEIVED
    if (readyState >= 2) {
      if (stats.loading.first === 0) {
        stats.loading.first = Math.max(
          self.performance.now(),
          stats.loading.start
        );
        // readyState >= 2 AND readyState !==4 (readyState = HEADERS_RECEIVED || LOADING) rearm timeout as xhr not finished yet
        self.clearTimeout(this.requestTimeout);
        config.timeout = config.loadPolicy.maxLoadTimeMs;
        this.requestTimeout = self.setTimeout(
          this.loadtimeout.bind(this),
          config.loadPolicy.maxLoadTimeMs -
            (stats.loading.first - stats.loading.start)
        );
      }

      if (readyState === 4) {
        self.clearTimeout(this.requestTimeout);
        xhr.onreadystatechange = null;
        xhr.onprogress = null;
        const status = xhr.status;
        // http status between 200 to 299 are all successful
        const useResponse = xhr.responseType !== 'text';
        if (
          status >= 200 &&
          status < 300 &&
          ((useResponse && xhr.response) || xhr.responseText !== null)
        ) {
          stats.loading.end = Math.max(
            self.performance.now(),
            stats.loading.first
          );
          const data = useResponse ? xhr.response : xhr.responseText;
          const len =
            xhr.responseType === 'arraybuffer' ? data.byteLength : data.length;
          stats.loaded = stats.total = len;
          if (!this.callbacks) {
            return;
          }
          const onProgress = this.callbacks.onProgress;
          if (onProgress) {
            onProgress(stats, context, data, xhr);
          }
          if (!this.callbacks) {
            return;
          }
          const response: LoaderResponse = {
            url: xhr.responseURL,
            data: data,
            code: status,
          };

          this.callbacks.onSuccess(response, stats, context, xhr);
        } else {
          const retryConfig = config.loadPolicy.errorRetry;
          const retryCount = stats.retry;
          // if max nb of retries reached or if http status between 400 and 499 (such error cannot be recovered, retrying is useless), return error
          if (shouldRetry(retryConfig, retryCount, false, status)) {
            this.retry(retryConfig);
          } else {
            logger.error(`${status} while loading ${context.url}`);
            this.callbacks!.onError(
              { code: status, text: xhr.statusText },
              context,
              xhr,
              stats
            );
          }
        }
      }
    }
  }

  loadtimeout(): void {
    const retryConfig = this.config?.loadPolicy.timeoutRetry;
    const retryCount = this.stats.retry;
    if (shouldRetry(retryConfig, retryCount, true)) {
      this.retry(retryConfig);
    } else {
      logger.warn(`timeout while loading ${this.context.url}`);
      const callbacks = this.callbacks;
      if (callbacks) {
        this.abortInternal();
        callbacks.onTimeout(this.stats, this.context, this.loader);
      }
    }
  }

  retry(retryConfig: RetryConfig) {
    const { context, stats } = this;
    this.retryDelay = getRetryDelay(retryConfig, stats.retry);
    stats.retry++;
    logger.warn(
      `${status ? 'HTTP Status ' + status : 'Timeout'} while loading ${
        context.url
      }, retrying ${stats.retry}/${retryConfig.maxNumRetry} in ${
        this.retryDelay
      }ms`
    );
    // abort and reset internal state
    this.abortInternal();
    this.loader = null;
    // schedule retry
    self.clearTimeout(this.retryTimeout);
    this.retryTimeout = self.setTimeout(
      this.loadInternal.bind(this),
      this.retryDelay
    );
  }

  loadprogress(event: ProgressEvent): void {
    const stats = this.stats;

    stats.loaded = event.loaded;
    if (event.lengthComputable) {
      stats.total = event.total;
    }
  }

  getCacheAge(): number | null {
    let result: number | null = null;
    if (
      this.loader &&
      AGE_HEADER_LINE_REGEX.test(this.loader.getAllResponseHeaders())
    ) {
      const ageHeader = this.loader.getResponseHeader('age');
      result = ageHeader ? parseFloat(ageHeader) : null;
    }
    return result;
  }

  getResponseHeader(name: string): string | null {
    if (
      this.loader &&
      new RegExp(`^${name}:\\s*[\\d.]+\\s*$`, 'im').test(
        this.loader.getAllResponseHeaders()
      )
    ) {
      return this.loader.getResponseHeader(name);
    }
    return null;
  }
}

export default XhrLoader;
