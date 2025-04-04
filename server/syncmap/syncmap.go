package syncmap

import "sync"

// SyncMap generic sync map
type SyncMap[K comparable, V any] struct {
	mu *sync.RWMutex
	m  map[K]V
}

func New[K comparable, V any]() SyncMap[K, V] {
	return SyncMap[K, V]{
		mu: &sync.RWMutex{},
		m:  make(map[K]V),
	}
}

func (g *SyncMap[K, V]) Get(key K) (V, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	v, ok := g.m[key]
	return v, ok
}

func (g *SyncMap[K, V]) Set(key K, value V) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.m[key] = value
}

func (g *SyncMap[K, V]) Delete(key K) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.m, key)
}

func (g *SyncMap[K, V]) Range(f func(key K, value V) bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	for k, v := range g.m {
		if !f(k, v) {
			break
		}
	}
}
