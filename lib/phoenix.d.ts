declare namespace phoenix {
    class Push {
        channel: Channel;
        event: string;
        payload: any;
        receivedResp: any;
        timeout: number;
        timeoutTimer: number;
        recHooks: any[];
        sent: boolean;
        ref: any;
        refEvent: any;
        constructor(channel: Channel, event: any, payload: any, timeout: any);
        resend(timeout: any): void;
        send(): void;
        receive(status: any, callback: any): this;
        matchReceive({status, response, ref}: {
            status: any;
            response: any;
            ref: any;
        }): void;
        cancelRefEvent(): void;
        cancelTimeout(): void;
        startTimeout(): void;
        hasReceived(status: any): boolean;
        trigger(status: any, response: any): void;
    }
    class Channel {
        state: string;
        topic: string;
        params: Object;
        socket: Socket;
        bindings: {
            event: string;
            callback: (payload?, ref?) => void;
        }[];
        timeout: number;
        joinedOnce: boolean;
        joinPush: Push;
        pushBuffer: any[];
        rejoinTimer: Timer;
        constructor(topic: any, params: any, socket: any);
        rejoinUntilConnected(): void;
        join(timeout?: number): Push;
        onClose(callback: any): void;
        onError(callback: any): void;
        on(event: any, callback: any): void;
        off(event: any): void;
        canPush(): boolean;
        push(event: any, payload: any, timeout?: number): Push;
        leave(timeout?: number): Push;
        onMessage(event: any, payload: any, ref: any): any;
        isMember(topic: any): boolean;
        joinRef(): any;
        sendJoin(timeout: any): void;
        rejoin(timeout?: number): void;
        trigger(event: any, payload?: any, ref?: any): void;
        replyEventName(ref: any): string;
        isClosed(): boolean;
        isErrored(): boolean;
        isJoined(): boolean;
        isJoining(): boolean;
        isLeaving(): boolean;
    }
    interface SocketOptions {
        timeout?: number;
        transport?: any;
        heartbeatIntervalMs?: number;
        reconnectAfterMs?: number;
        logger?: any;
        longpollerTimeout?: number;
        params?: any;
    }
    class Socket {
        stateChangeCallbacks: {
            open: any[];
            close: any[];
            error: any[];
            message: any[];
        };
        channels: Channel[];
        sendBuffer: any[];
        ref: number;
        timeout: number;
        transport: any;
        heartbeatTimer: number;
        heartbeatIntervalMs: number;
        reconnectAfterMs: number | ((tries: any) => number);
        logger: any;
        longpollerTimeout: number;
        params: any;
        endPoint: string;
        reconnectTimer: Timer;
        conn: any;
        constructor(endPoint: any, opts: SocketOptions);
        protocol(): string;
        endPointURL(): any;
        disconnect(callback?: any, code?: any, reason?: any): void;
        connect(params?: any): void;
        log(kind: any, msg: any, data?: any): void;
        onOpen(callback: any): void;
        onClose(callback: any): void;
        onError(callback: any): void;
        onMessage(callback: any): void;
        onConnOpen(): void;
        onConnClose(event: any): void;
        onConnError(error: any): void;
        triggerChanError(): void;
        connectionState(): string;
        isConnected(): boolean;
        remove(channel: any): void;
        channel(topic: any, chanParams?: {}): Channel;
        push(data: any): void;
        makeRef(): string;
        sendHeartbeat(): void;
        flushSendBuffer(): void;
        onConnMessage(rawMessage: any): void;
    }
    class LongPoll {
        endPoint: string;
        pollEndpoint: string;
        token: string;
        skipHeartbeat: boolean;
        onopen: () => void;
        onerror: (reason?) => void;
        onmessage: (message: {
            data?: any;
        }) => void;
        onclose: () => void;
        readyState: number;
        timeout: number;
        constructor(endPoint: any);
        normalizeEndpoint(endPoint: any): any;
        endpointURL(): any;
        closeAndRetry(): void;
        ontimeout(): void;
        poll(): void;
        send(body: any): void;
        close(code?: any, reason?: any): void;
    }
    class Presence {
        static syncState(currentState: any, newState: any, onJoin: any, onLeave: any): any;
        static syncDiff(currentState: any, {joins, leaves}: {
            joins: any;
            leaves: any;
        }, onJoin: any, onLeave: any): any;
        static list(presences: any, chooser: any): any[];
        static map(obj: any, func: any): any[];
        static clone(obj: any): any;
    }
    class Timer {
        callback: any;
        timerCalc: any;
        timer: any;
        tries: number;
        constructor(callback: any, timerCalc: any);
        reset(): void;
        scheduleTimeout(): void;
    }
}
export = phoenix;
