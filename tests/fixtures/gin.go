package main

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func main() {
	db, _ := gorm.Open(nil, nil)
	_ = db
	r := gin.Default()
	r.GET("/ping", func(c *gin.Context) {
		c.JSON(200, gin.H{"message": "pong"})
	})
	r.Run()
}
