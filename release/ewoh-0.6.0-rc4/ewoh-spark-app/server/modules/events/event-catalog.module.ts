import { Module } from '@nestjs/common';
import { EventCatalogController } from './event-catalog.controller';
import { EventCatalogService } from './event-catalog.service';

@Module({
  controllers: [EventCatalogController],
  providers: [EventCatalogService],
  exports: [EventCatalogService],
})
export class EventCatalogModule {}
