import { http as httpFollow } from 'follow-redirects';
import { https as httpsFollow } from 'follow-redirects';
import * as http from 'http';
import * as https from 'https';
import { Observable, Observer } from 'rxjs';
import * as url from 'url';
import * as zlib from 'zlib';

import { oxidVersion } from '../metadata';
import { RequestConfigNode, ResponseType } from '../Request';
import { HttpEvent, HttpEventType, HttpResponse } from '../Response';
import { isString } from '../utils/base';
import { isArrayBuffer, isStream } from '../utils/base';
import { createError, enhanceError } from '../utils/createError';
import { getObserverHandler } from '../utils/getObserverHandler';
import { parseJsonResponse } from '../utils/parseJsonResponse';
import { buildURL } from '../utils/urls';

const isHttps = /https:?/;

const httpAdapter = <T = any>(config: RequestConfigNode) =>
  new Observable((observer: Observer<HttpEvent<T>>) => {
    const { emitError, emitComplete } = getObserverHandler(observer);
    let transportRequest: http.ClientRequest;

    const tearDown = () => {
      if (!transportRequest || transportRequest.aborted) {
        return;
      }
      transportRequest.abort();
    };

    let data = config.data;
    const { proxy, headers = {}, maxContentLength, url: configUrl, method } = config;

    if (!configUrl || !method) {
      emitError(createError(`Invalid request configuration`));
      return tearDown;
    }

    // Set User-Agent (required by some servers)
    // Only set header if it hasn't been set in config
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = `oxid/${oxidVersion}`;
    }

    if (data && !isStream(data)) {
      if (Buffer.isBuffer(data)) {
        // Noop, nothing to do
      } else if (isArrayBuffer(data)) {
        //https://github.com/nodejs/node/issues/14118#issuecomment-313933800,
        //Buffer.from accepts Uint8Array but type doesn't reflect it
        data = Buffer.from(new Uint8Array(data) as any);
      } else if (isString(data)) {
        data = Buffer.from(data, 'utf-8');
      } else {
        emitError(
          createError('Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream', config)
        );
        return tearDown;
      }

      // Add Content-Length header if data exists
      headers['Content-Length'] = data.length;
    }

    // HTTP basic authentication
    let auth = undefined;
    if (config.auth) {
      const username = config.auth.username || '';
      const password = config.auth.password || '';
      auth = username + ':' + password;
    }

    // Parse url
    const parsed = url.parse(configUrl);
    const protocol = parsed.protocol || 'http:';

    if (!auth && parsed.auth) {
      const urlAuth = parsed.auth.split(':');
      const urlUsername = urlAuth[0] || '';
      const urlPassword = urlAuth[1] || '';
      auth = urlUsername + ':' + urlPassword;
    }

    if (auth) {
      delete headers.Authorization;
    }

    const isHttpsRequest = isHttps.test(protocol);
    const agent = isHttpsRequest ? config.httpsAgent : config.httpAgent;

    const options: any = {
      path: buildURL(parsed.path!, config.params, config.paramsSerializer).replace(/^\?/, ''),
      method: method.toUpperCase(),
      headers,
      agent: agent,
      auth: auth
    };

    if (config.socketPath) {
      options.socketPath = config.socketPath;
    } else {
      options.hostname = parsed.hostname;
      options.port = parsed.port;
    }

    if (proxy) {
      options.hostname = proxy.host;
      options.host = proxy.host;
      options.headers.host = parsed.hostname + (parsed.port ? ':' + parsed.port : '');
      options.port = proxy.port;
      options.path = protocol + '//' + parsed.hostname + (parsed.port ? ':' + parsed.port : '') + options.path;

      // Basic proxy authorization
      if (proxy.auth) {
        const base64 = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`, 'utf8').toString('base64');
        options.headers['Proxy-Authorization'] = 'Basic ' + base64;
      }
    }

    let transport: { request: typeof import('http').request };
    const isHttpsProxy = isHttpsRequest && (proxy ? isHttps.test(proxy.protocol || 'http') : true);
    if (config.transport) {
      transport = config.transport as any;
    } else if (config.maxRedirects === 0) {
      transport = isHttpsProxy ? https : http;
    } else {
      if (config.maxRedirects) {
        options.maxRedirects = config.maxRedirects;
      }
      transport = isHttpsProxy ? httpsFollow : httpFollow;
    }

    if (maxContentLength && maxContentLength > -1) {
      options.maxBodyLength = maxContentLength;
    }

    // Create the request
    transportRequest = transport.request(options, res => {
      if (transportRequest.aborted) {
        //TODO: should it error?
        return;
      }

      // uncompress the response body transparently if required
      let stream = res;
      switch (res.headers['content-encoding']) {
        case 'gzip':
        case 'compress':
        case 'deflate':
          // add the unzipper to the body stream processing pipeline
          stream = stream.pipe<any>(zlib.createUnzip());

          // remove the content-encoding in order to not confuse downstream operations
          delete res.headers['content-encoding'];
          break;
      }

      // return the last request in case of redirects
      const lastRequest = (res as any).req || transportRequest;

      const response = {
        status: Number.isSafeInteger(res.statusCode!) ? res.statusCode : Number.NaN,
        statusText: res.statusMessage || '',
        headers: res.headers,
        config: config,
        request: lastRequest
      } as HttpResponse<any>;

      if (config.responseType === ResponseType.Stream) {
        response.data = stream;
        emitComplete(response);
      } else {
        const responseBuffer: Array<any> = [];
        stream.on('data', chunk => {
          responseBuffer.push(chunk);

          // make sure the content length is not over the maxContentLength if specified
          if (!!maxContentLength && maxContentLength > -1 && Buffer.concat(responseBuffer).length > maxContentLength) {
            emitError(createError(`maxContentLength size of ${maxContentLength} exceeded`, config, null, lastRequest));
          }
        });

        stream.on('error', err => {
          if (transportRequest.aborted) {
            return;
          }
          emitError(enhanceError(err, config, null, lastRequest));
        });

        stream.on('end', () => {
          let responseData: any = Buffer.concat(responseBuffer.filter(x => !!x));
          if (config.responseType !== ResponseType.ArrayBuffer) {
            responseData = responseData.toString(config.responseEncoding);
          }

          const parsedBody =
            config.responseType === 'json' && isString(responseData)
              ? parseJsonResponse(response.status, responseData)
              : { ok: true, body: responseData };

          response.data = parsedBody.body;

          //This will raised as error regardless existence of `validateStatus`
          if (!parsedBody.ok) {
            emitError(createError('Response parse failed', config, response.statusText, transportRequest, response));
          } else {
            // Applying same normalization logic as xhr
            if (response.status === 0) {
              response.status = !!responseData ? 200 : 0;
            }
            // The full body has been received and delivered, no further events
            // are possible. This request is complete.
            emitComplete(response);
          }
        });
      }
    });

    // Handle errors
    transportRequest.on('error', err => {
      if (transportRequest.aborted) {
        return;
      }
      emitError(enhanceError(err, config, null, transportRequest));
    });

    // Fire the request, and notify the event stream that it was fired.
    if (isStream(data)) {
      data.on('error', err => emitError(enhanceError(err, config, null, transportRequest))).pipe(transportRequest);
    } else {
      transportRequest.end(data);
    }
    observer.next({ type: HttpEventType.Sent });

    return tearDown;
  });

export { httpAdapter as adapter };
