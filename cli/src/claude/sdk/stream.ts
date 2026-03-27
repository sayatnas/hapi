/**
 * Stream implementation for handling async message streams
 * Provides an async iterable interface for processing SDK messages
 */

/**
 * Generic async stream implementation
 * Handles queuing, error propagation, and proper cleanup
 */
export class Stream<T> implements AsyncIterableIterator<T> {
    private queue: T[] = []
    private readResolve?: (value: IteratorResult<T>) => void
    private readReject?: (error: Error) => void
    private isDone = false
    private hasError?: Error
    private started = false
    private _onNotify?: () => void

    constructor(private returned?: () => void) {}

    /**
     * Set a notification callback that fires when data becomes available,
     * the stream ends, or an error occurs. Used to detect background task
     * notifications arriving while waiting for user input.
     */
    setOnNotify(cb: (() => void) | null): void {
        this._onNotify = cb ?? undefined
    }

    /**
     * Number of buffered items not yet consumed by the iterator
     */
    get pendingCount(): number {
        return this.queue.length
    }

    /**
     * Whether the stream has finished (done or errored)
     */
    get isFinished(): boolean {
        return this.isDone || !!this.hasError
    }

    /**
     * Implements async iterable protocol
     */
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        if (this.started) {
            throw new Error('Stream can only be iterated once')
        }
        this.started = true
        return this
    }

    /**
     * Gets the next value from the stream
     */
    async next(): Promise<IteratorResult<T>> {
        // Return queued items first
        if (this.queue.length > 0) {
            return Promise.resolve({
                done: false,
                value: this.queue.shift()!
            })
        }

        // Check terminal states
        if (this.isDone) {
            return Promise.resolve({ done: true, value: undefined })
        }

        if (this.hasError) {
            return Promise.reject(this.hasError)
        }

        // Wait for new data
        return new Promise((resolve, reject) => {
            this.readResolve = resolve
            this.readReject = reject
        })
    }

    /**
     * Adds a value to the stream
     */
    enqueue(value: T): void {
        if (this.readResolve) {
            // Direct delivery to waiting consumer
            const resolve = this.readResolve
            this.readResolve = undefined
            this.readReject = undefined
            resolve({ done: false, value })
        } else {
            // Queue for later consumption
            this.queue.push(value)
        }
        this._onNotify?.()
    }

    /**
     * Marks the stream as complete
     */
    done(): void {
        this.isDone = true
        if (this.readResolve) {
            const resolve = this.readResolve
            this.readResolve = undefined
            this.readReject = undefined
            resolve({ done: true, value: undefined })
        }
        this._onNotify?.()
    }

    /**
     * Propagates an error through the stream
     */
    error(error: Error): void {
        this.hasError = error
        if (this.readReject) {
            const reject = this.readReject
            this.readResolve = undefined
            this.readReject = undefined
            reject(error)
        }
        this._onNotify?.()
    }

    /**
     * Implements async iterator cleanup
     */
    async return(): Promise<IteratorResult<T>> {
        this.isDone = true
        if (this.returned) {
            this.returned()
        }
        return Promise.resolve({ done: true, value: undefined })
    }
}